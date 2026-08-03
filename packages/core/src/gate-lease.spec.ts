import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GateLeaseOptions, acquireGateLease, withGateLease } from "./gate-lease";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-lease-test-"));
  dirs.push(d);
  return d;
}

const TUNING_VARS = ["MCX_GATE_LEASE_SLOTS", "MCX_GATE_LEASE_MAX_LOAD", "MCX_GATE_LEASE_LOAD_WAIT_MS"] as const;
const savedEnv = new Map(TUNING_VARS.map((k) => [k, process.env[k]]));

/** Clear the tuning vars so an ambient value can't steer a defaults test. */
function clearTuningEnv(): void {
  for (const k of TUNING_VARS) {
    delete process.env[k];
  }
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  for (const [k, v] of savedEnv) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

// maxLoad: 0 disables the load-headroom stage — these cases exercise slot
// admission only, and the real host load would otherwise steer them.
const noWait = { sleep: () => Promise.resolve(), random: () => 0, maxLoad: 0 };

describe("acquireGateLease", () => {
  it("acquires a slot when one is free", async () => {
    const lockDir = freshDir();
    const lease = await acquireGateLease({ slots: 2, lockDir, ...noWait });
    expect(lease.held).toBe(true);
    expect(lease.slot).toBe(0);
    lease.release();
  });

  it("allows K concurrent holders, blocks the K+1th until a release", async () => {
    const lockDir = freshDir();
    const a = await acquireGateLease({ slots: 2, lockDir, ...noWait });
    const b = await acquireGateLease({ slots: 2, lockDir, ...noWait });
    expect(a.held).toBe(true);
    expect(b.held).toBe(true);
    expect(new Set([a.slot, b.slot]).size).toBe(2); // distinct slots

    // Third acquisition with both slots taken must wait. Drive a manual clock
    // so it would fail-open quickly if it never got a slot, then free a slot
    // mid-wait and confirm it acquires instead.
    let ticks = 0;
    let released = false;
    const warnings: string[] = [];
    const c = await acquireGateLease({
      slots: 2,
      lockDir,
      timeoutMs: 10_000,
      now: () => ticks,
      sleep: async () => {
        ticks += 100;
        if (!released) {
          released = true;
          a.release(); // free slot 0 after the first poll
        }
      },
      random: () => 0,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(c.held).toBe(true);
    expect(c.slot).toBe(a.slot); // reused the freed slot
    expect(warnings.some((w) => w.includes("queueing"))).toBe(true);
    expect(warnings.some((w) => w.includes("acquired") && w.includes("after waiting"))).toBe(true);

    b.release();
    c.release();
  });

  it("fails open (unheld lease) when all slots stay busy past the deadline", async () => {
    const lockDir = freshDir();
    const a = await acquireGateLease({ slots: 1, lockDir, ...noWait });
    expect(a.held).toBe(true);

    const warnings: string[] = [];
    let ticks = 0;
    const b = await acquireGateLease({
      slots: 1,
      lockDir,
      timeoutMs: 500,
      now: () => ticks,
      sleep: async () => {
        ticks += 1000; // blow past the deadline on the first poll
      },
      random: () => 0,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(b.held).toBe(false);
    expect(b.slot).toBeNull();
    expect(warnings.some((w) => w.includes("fail-open"))).toBe(true);

    a.release();
  });

  it("is a no-op when slots <= 0 (disabled)", async () => {
    const lockDir = freshDir();
    const lease = await acquireGateLease({ slots: 0, lockDir, ...noWait });
    expect(lease.held).toBe(false);
    expect(lease.slot).toBeNull();
    lease.release(); // must not throw
  });

  it("release is idempotent and frees the slot for re-acquisition", async () => {
    const lockDir = freshDir();
    const a = await acquireGateLease({ slots: 1, lockDir, ...noWait });
    a.release();
    a.release(); // idempotent

    const b = await acquireGateLease({ slots: 1, lockDir, ...noWait });
    expect(b.held).toBe(true);
    b.release();
  });

  it("fails open with a warning when the lock dir cannot be created", async () => {
    // Point lockDir at a path under a regular file so mkdir throws ENOTDIR.
    const base = freshDir();
    const filePath = join(base, "not-a-dir");
    writeFileSync(filePath, "x");
    const lockDir = join(filePath, "gate-locks");

    const warnings: string[] = [];
    const lease = await acquireGateLease({
      slots: 2,
      lockDir,
      ...noWait,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(lease.held).toBe(false);
    expect(lease.slot).toBeNull();
    expect(warnings.some((w) => w.includes("could not create lock dir") && w.includes("fail-open"))).toBe(true);
    lease.release(); // must not throw
  });
});

describe("MCX_GATE_LEASE_SLOTS validation", () => {
  it("caps to the max and warns when the env value is absurdly large", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "999999";
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir, ...noWait, logger: { warn: (m) => warnings.push(m) } });
    expect(lease.held).toBe(true);
    expect(lease.slot).toBe(0);
    expect(warnings.some((w) => w.includes("exceeds max") && w.includes("capping"))).toBe(true);
    lease.release();
  });

  it("warns and falls back to the default for a non-integer env value", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "2abc";
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir, ...noWait, logger: { warn: (m) => warnings.push(m) } });
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("is not an integer"))).toBe(true);
    lease.release();
  });

  it("warns when a negative env value disables the gate", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "-1";
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir, ...noWait, logger: { warn: (m) => warnings.push(m) } });
    expect(lease.held).toBe(false);
    expect(lease.slot).toBeNull();
    expect(warnings.some((w) => w.includes("disables the gate"))).toBe(true);
  });
});

// A lease whose slot wait fails open immediately: drives the injected clock past
// the deadline on the first poll.
function failFastSlotWait(lockDir: string, extra: GateLeaseOptions = {}) {
  let ticks = 0;
  return acquireGateLease({
    lockDir,
    timeoutMs: 500,
    now: () => ticks,
    sleep: async () => {
      ticks += 1000;
    },
    random: () => 0,
    maxLoad: 0,
    ...extra,
  });
}

describe("default slot count derived from core count (#2690)", () => {
  it("allows 1 concurrent run on an 8-core host", async () => {
    clearTuningEnv();
    const lockDir = freshDir();
    const a = await acquireGateLease({ lockDir, cpuCount: () => 8, ...noWait });
    expect(a.held).toBe(true);

    const b = await failFastSlotWait(lockDir, { cpuCount: () => 8 });
    expect(b.held).toBe(false);
    a.release();
  });

  it("allows 2 — not the issue's cores/4 = 4 — on a 16-core host", async () => {
    clearTuningEnv();
    const lockDir = freshDir();
    const cpuCount = () => 16;
    const a = await acquireGateLease({ lockDir, cpuCount, ...noWait });
    const b = await acquireGateLease({ lockDir, cpuCount, ...noWait });
    expect([a.held, b.held]).toEqual([true, true]);

    // The third must be refused. cores/4 would have admitted a third and fourth,
    // which is the regime the field data shows failing.
    const c = await failFastSlotWait(lockDir, { cpuCount });
    expect(c.held).toBe(false);
    a.release();
    b.release();
  });

  it("never derives 0 slots on a single-core host", async () => {
    clearTuningEnv();
    const lockDir = freshDir();
    const a = await acquireGateLease({ lockDir, cpuCount: () => 1, ...noWait });
    expect(a.held).toBe(true);
    a.release();
  });
});

describe("load-headroom admission (#2690)", () => {
  it("holds the slot while load is too high, then admits when it falls", async () => {
    const lockDir = freshDir();
    const loads = [20, 20, 5];
    let i = 0;
    let ticks = 0;
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      maxLoad: 10,
      loadWaitMs: 60_000,
      now: () => ticks,
      sleep: async () => {
        ticks += 100;
      },
      random: () => 0,
      loadAvg: () => loads[Math.min(i++, loads.length - 1)] as number,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(lease.held).toBe(true);
    expect(lease.slot).toBe(0);
    expect(warnings.some((w) => w.includes("holding slot 0, waiting for host load"))).toBe(true);
    expect(warnings.some((w) => w.includes("admitted after waiting"))).toBe(true);
    lease.release();
  });

  it("keeps the slot held while waiting, so a peer cannot start meanwhile", async () => {
    const lockDir = freshDir();
    const probes: boolean[] = [];
    let ticks = 0;
    let load = 50;
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      maxLoad: 10,
      loadWaitMs: 60_000,
      now: () => ticks,
      sleep: async () => {
        ticks += 100;
        // Mid-load-wait: a peer must find the only slot already taken. This is
        // what prevents the convoy — the waiter owns the slot while it waits.
        if (probes.length === 0) {
          probes.push((await failFastSlotWait(lockDir, { slots: 1 })).held);
          load = 1; // let the original proceed on the next poll
        }
      },
      random: () => 0,
      loadAvg: () => load,
    });

    expect(probes).toEqual([false]);
    expect(lease.held).toBe(true);
    lease.release();
  });

  it("fails open after the load-wait deadline and still holds the slot", async () => {
    const lockDir = freshDir();
    let ticks = 0;
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      maxLoad: 10,
      loadWaitMs: 500,
      now: () => ticks,
      sleep: async () => {
        ticks += 1000; // blow past the load deadline on the first poll
      },
      random: () => 0,
      loadAvg: () => 99,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("still above") && w.includes("fail-open"))).toBe(true);
    lease.release();
  });

  it("defaults the ceiling to 0.75 x cores", async () => {
    clearTuningEnv();
    const cpuCount = () => 16; // ceiling = 12

    const belowDir = freshDir();
    const belowWarnings: string[] = [];
    const below = await acquireGateLease({
      lockDir: belowDir,
      slots: 1,
      cpuCount,
      loadAvg: () => 11.9,
      sleep: () => Promise.resolve(),
      random: () => 0,
      logger: { warn: (m) => belowWarnings.push(m) },
    });
    expect(below.held).toBe(true);
    expect(belowWarnings.some((w) => w.includes("waiting for host load"))).toBe(false);
    below.release();

    const aboveDir = freshDir();
    const aboveWarnings: string[] = [];
    let ticks = 0;
    const above = await acquireGateLease({
      lockDir: aboveDir,
      slots: 1,
      cpuCount,
      loadAvg: () => 12.1,
      loadWaitMs: 500,
      now: () => ticks,
      sleep: async () => {
        ticks += 1000;
      },
      random: () => 0,
      logger: { warn: (m) => aboveWarnings.push(m) },
    });
    expect(aboveWarnings.some((w) => w.includes("waiting for host load"))).toBe(true);
    above.release();
  });
});

describe("load-wait env overrides (#2690)", () => {
  it("skips the load wait entirely when MCX_GATE_LEASE_MAX_LOAD is 0", async () => {
    clearTuningEnv();
    process.env.MCX_GATE_LEASE_MAX_LOAD = "0";
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      loadAvg: () => 999,
      sleep: () => Promise.resolve(),
      random: () => 0,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("disables the load wait"))).toBe(true);
    lease.release();
  });

  it("warns and falls back to the default for a non-numeric MCX_GATE_LEASE_MAX_LOAD", async () => {
    clearTuningEnv();
    process.env.MCX_GATE_LEASE_MAX_LOAD = "high";
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      cpuCount: () => 16,
      loadAvg: () => 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("is not a number"))).toBe(true);
    lease.release();
  });

  it("honours MCX_GATE_LEASE_LOAD_WAIT_MS as the fail-open bound", async () => {
    clearTuningEnv();
    process.env.MCX_GATE_LEASE_LOAD_WAIT_MS = "1";
    const lockDir = freshDir();
    const warnings: string[] = [];
    let ticks = 0;
    const lease = await acquireGateLease({
      lockDir,
      slots: 1,
      maxLoad: 10,
      now: () => ticks,
      sleep: async () => {
        ticks += 5; // trips the 1ms bound, far short of the 5min default
      },
      random: () => 0,
      loadAvg: () => 99,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("after 1ms") && w.includes("fail-open"))).toBe(true);
    lease.release();
  });
});

describe("withGateLease", () => {
  it("runs fn while holding a slot and releases afterwards", async () => {
    const lockDir = freshDir();
    let ranWithSlotTaken = false;
    const result = await withGateLease(
      async () => {
        // While inside, the only slot is taken — a non-blocking probe must wait.
        const probe = await acquireGateLease({
          slots: 1,
          lockDir,
          timeoutMs: 0,
          now: () => 1,
          sleep: () => Promise.resolve(),
          random: () => 0,
        });
        ranWithSlotTaken = !probe.held;
        return 42;
      },
      { slots: 1, lockDir, ...noWait },
    );
    expect(result).toBe(42);
    expect(ranWithSlotTaken).toBe(true);

    // After withGateLease returns, the slot is free again.
    const after = await acquireGateLease({ slots: 1, lockDir, ...noWait });
    expect(after.held).toBe(true);
    after.release();
  });

  it("releases the slot even when fn throws", async () => {
    const lockDir = freshDir();
    await expect(
      withGateLease(
        async () => {
          throw new Error("boom");
        },
        { slots: 1, lockDir, ...noWait },
      ),
    ).rejects.toThrow("boom");

    const after = await acquireGateLease({ slots: 1, lockDir, ...noWait });
    expect(after.held).toBe(true);
    after.release();
  });
});
