import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireGateLease, withGateLease } from "./gate-lease";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-lease-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const noWait = { sleep: () => Promise.resolve(), random: () => 0 };
const originalSlotsEnv = process.env.MCX_GATE_LEASE_SLOTS;

describe("acquireGateLease", () => {
  afterEach(() => {
    if (originalSlotsEnv === undefined) {
      process.env.MCX_GATE_LEASE_SLOTS = "";
    } else {
      process.env.MCX_GATE_LEASE_SLOTS = originalSlotsEnv;
    }
  });

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

  it("fails open when the lock directory cannot be created", async () => {
    const parent = freshDir();
    const file = join(parent, "not-a-directory");
    writeFileSync(file, "");
    const warnings: string[] = [];

    const lease = await acquireGateLease({
      slots: 1,
      lockDir: join(file, "locks"),
      logger: { warn: (m) => warnings.push(m) },
      ...noWait,
    });

    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("could not create lock dir") && w.includes("fail-open"))).toBe(true);
  });

  it("caps an excessive MCX_GATE_LEASE_SLOTS value and warns", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "999999";
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir: freshDir(),
      logger: { warn: (m) => warnings.push(m) },
      ...noWait,
    });

    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("exceeds max 64") && w.includes("capping"))).toBe(true);
    lease.release();
  });

  it("rejects partial numeric MCX_GATE_LEASE_SLOTS values instead of truncating them", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "2abc";
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir: freshDir(),
      logger: { warn: (m) => warnings.push(m) },
      ...noWait,
    });

    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("invalid MCX_GATE_LEASE_SLOTS=2abc"))).toBe(true);
    lease.release();
  });

  it("warns when MCX_GATE_LEASE_SLOTS disables the lease", async () => {
    process.env.MCX_GATE_LEASE_SLOTS = "-1";
    const warnings: string[] = [];
    const lease = await acquireGateLease({
      lockDir: freshDir(),
      logger: { warn: (m) => warnings.push(m) },
      ...noWait,
    });

    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("disables gate lease"))).toBe(true);
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
