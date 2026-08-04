import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GateLease, type GateLeaseOptions, acquireGateLease } from "./gate-lease";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-lease-test-"));
  dirs.push(d);
  return d;
}

const TUNING_VARS = ["MCX_GATE_LEASE_SLOTS", "MCX_GATE_LEASE_MAX_BUSY", "MCX_GATE_LEASE_WAIT_MS"] as const;
const savedEnv = new Map(TUNING_VARS.map((k) => [k, process.env[k]]));

/** Clear the tuning vars so an ambient value can't steer a defaults test. */
function clearTuningEnv(): void {
  for (const k of TUNING_VARS) {
    delete process.env[k];
  }
}

const leases: GateLease[] = [];
/** Track leases so a failing assertion can't strand a flock into the next test. */
function track(lease: GateLease): GateLease {
  leases.push(lease);
  return lease;
}

afterEach(() => {
  while (leases.length) leases.pop()?.release();
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

/**
 * The DEFAULT production configuration: slot count and busy ceiling both left at
 * their defaults, never pinned. Only the *signal* and the clock are injected — a
 * test that pins `slots` cannot say anything about the behaviour real runs get
 * (the mistake called out in the #2949 review). Tests that need K > 1 to have a
 * distinguishable free slot pass `slots` explicitly and say so.
 */
function defaults(overrides: GateLeaseOptions = {}): GateLeaseOptions {
  clearTuningEnv();
  let ticks = 0;
  return {
    cpuBusy: () => 0.1, // idle host; the ceiling itself stays at its default
    now: () => ticks,
    sleep: async (ms) => {
      ticks += ms;
    },
    random: () => 0,
    ...overrides,
  };
}

describe("acquireGateLease at the default configuration (#2690)", () => {
  it("admits immediately on an idle host", async () => {
    const lockDir = freshDir();
    const infos: string[] = [];
    const lease = track(await acquireGateLease({ lockDir, ...defaults({ logger: { info: (m) => infos.push(m) } }) }));
    expect(lease.held).toBe(true);
    expect(lease.slot).toBe(0);
    expect(infos.some((m) => m.includes("admitted on slot 0") && m.includes("slots=1"))).toBe(true);
  });

  it("admits exactly one gate run at a time — not the issue's cores/4", async () => {
    const lockDir = freshDir();
    const a = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(a.held).toBe(true);
    expect(a.slot).toBe(0);

    // The second must be refused. `cores/4` would have admitted four on the
    // 16-core reference host, which is the regime the field data shows failing.
    const warnings: string[] = [];
    const b = await acquireGateLease({
      lockDir,
      ...defaults({ waitMs: 1000, logger: { warn: (m) => warnings.push(m) } }),
    });
    expect(b.held).toBe(false);
    expect(warnings.some((w) => w.includes("for a free slot (all 1 busy)"))).toBe(true);
    expect(warnings.some((w) => w.includes("proceeding unleased") && w.includes("fail-open"))).toBe(true);
  });

  it("blocks a solo run on CPU headroom while the slot is free, then admits when it clears", async () => {
    // Default configuration, no peer: slot 0 is free the whole time, so this
    // isolates the headroom stage from the slot count.
    const lockDir = freshDir();
    const busy = [0.95, 0.95, 0.2];
    let i = 0;
    const warnings: string[] = [];
    const b = track(
      await acquireGateLease({
        lockDir,
        ...defaults({
          waitMs: 60_000,
          cpuBusy: () => busy[Math.min(i++, busy.length - 1)] as number,
          logger: { warn: (m) => warnings.push(m) },
        }),
      }),
    );

    expect(b.held).toBe(true);
    expect(b.slot).toBe(0);
    expect(warnings.some((w) => w.includes("for cpu headroom") && w.includes("95% busy"))).toBe(true);
    // Default ceiling is 0.6, so the message must report 60% — not a pinned value.
    expect(warnings.some((w) => w.includes("need < 60%"))).toBe(true);
    // A run that queued reports its admission at warn too, so the wait and its
    // resolution both survive the am-i-done AI log (which is dropped on success).
    expect(warnings.some((w) => w.includes("admitted on slot 0"))).toBe(true);
  });

  it("serializes admission decisions, so two runs never evaluate headroom at once", async () => {
    // Guarantee 2. `slots: 2` is NOT the default — it is passed here precisely so
    // a free slot exists during the nested probe, proving it is the admission
    // token and not the slot count that keeps the peer out. At the default K=1
    // the slot alone would refuse it and the test would prove nothing.
    const lockDir = freshDir();
    const peerHeld: boolean[] = [];
    let peerWarnings: string[] = [];

    const a = track(
      await acquireGateLease({
        lockDir,
        ...defaults({
          slots: 2,
          cpuBusy: async () => {
            peerWarnings = [];
            const peer = await acquireGateLease({
              lockDir,
              ...defaults({ slots: 2, waitMs: 0, logger: { warn: (m) => peerWarnings.push(m) } }),
            });
            peerHeld.push(peer.held);
            peer.release();
            return 0.1;
          },
        }),
      }),
    );

    expect(a.held).toBe(true);
    // The peer never got to evaluate headroom — A held the decision mutex for the
    // whole of the peer's budget, which is the ordering property under test.
    expect(peerWarnings.some((w) => w.includes("no admission token"))).toBe(true);
    // Having lost the token it still fails open onto the free slot 1 rather than
    // running uncounted: the run that waited longest must not get the worse deal
    // of the two fail-open paths (#2949 review, finding C).
    expect(peerHeld).toEqual([true]);
    expect(peerWarnings.some((w) => w.includes("proceeding on slot 1"))).toBe(true);
  });

  it("admits a solo run without sleeping on anything but the CPU sample", async () => {
    const soloDir = freshDir();
    const soloSleeps: number[] = [];
    const solo = track(
      await acquireGateLease({
        lockDir: soloDir,
        ...defaults({ sleep: async (ms) => void soloSleeps.push(ms) }),
      }),
    );
    expect(solo.held).toBe(true);
    // The common case pays no settle, no poll and no queue.
    expect(soloSleeps).toEqual([]);
  });

  it("jitters each process's fail-open deadline downward so losers don't release in lockstep", async () => {
    // Same waitMs, a different jitter draw per process => a different effective
    // budget each, so N co-launched losers scatter instead of all failing open
    // within one poll of each other.
    const budgets: number[] = [];
    for (const draw of [0, 0.5, 1]) {
      const lockDir = freshDir();
      let ticks = 0;
      const warnings: string[] = [];
      track(
        await acquireGateLease({
          lockDir,
          ...defaults({
            waitMs: 100_000,
            random: () => draw,
            cpuBusy: () => 0.99, // never clears, so the budget is always spent
            now: () => ticks,
            sleep: async (ms) => {
              ticks += ms;
            },
            logger: { warn: (m) => warnings.push(m) },
          }),
        }),
      );
      const m = warnings.join("\n").match(/no admission within (\d+)ms/);
      expect(m).not.toBeNull();
      budgets.push(Number(m?.[1]));
    }

    // Downward only: never above the configured budget (the 600s worker-timeout
    // arithmetic depends on that), never below 75% of it.
    for (const b of budgets) {
      expect(b).toBeLessThanOrEqual(100_000);
      expect(b).toBeGreaterThanOrEqual(75_000);
    }
    // And genuinely spread, so the fail-opens don't convoy.
    expect(new Set(budgets).size).toBe(3);
    expect(Math.max(...budgets) - Math.min(...budgets)).toBeGreaterThan(20_000);
  });

  it("never fails the run it wraps, even when the CPU signal throws mid-decision", async () => {
    const lockDir = freshDir();
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({
        lockDir,
        ...defaults({
          cpuBusy: () => {
            throw new Error("sampler exploded");
          },
          logger: { warn: (m) => warnings.push(m) },
        }),
      }),
    );

    // Fail-open, not a throw: an admission bug must never become a phantom gate
    // failure (#2690).
    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("admission failed unexpectedly") && w.includes("sampler exploded"))).toBe(
      true,
    );

    // And the slot it held when the sampler threw was not stranded — there is no
    // reaper to clean that up, so the throwing frame has to release it.
    const next = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(next.held).toBe(true);
    expect(next.slot).toBe(0);
  });

  it("charges one whole-run budget, and fails open onto a free slot when it expires", async () => {
    const lockDir = freshDir();
    let ticks = 0;
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({
        lockDir,
        ...defaults({
          waitMs: 5000,
          cpuBusy: () => 0.99, // never clears
          now: () => ticks,
          sleep: async (ms) => {
            ticks += ms;
          },
          logger: { warn: (m) => warnings.push(m) },
        }),
      }),
    );

    // Fail-open still prefers a slot over running uncounted.
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("no admission within 5000ms") && w.includes("on slot 0"))).toBe(true);
    // Budget is whole-run: the wait stopped at the budget, it did not restart.
    expect(ticks).toBeGreaterThanOrEqual(5000);
    expect(ticks).toBeLessThan(6000);
  });

  it("re-announces a long wait with elapsed/remaining so it never reads as a wedge", async () => {
    const lockDir = freshDir();
    let ticks = 0;
    const warnings: string[] = [];
    track(
      await acquireGateLease({
        lockDir,
        ...defaults({
          waitMs: 90_000,
          pollIntervalMs: 20_000, // 4 polls before the budget expires
          cpuBusy: () => 0.99,
          now: () => ticks,
          sleep: async (ms) => {
            ticks += ms;
          },
          logger: { warn: (m) => warnings.push(m) },
        }),
      }),
    );
    const waits = warnings.filter((w) => w.includes("for cpu headroom"));
    expect(waits.length).toBeGreaterThan(1);
    expect(waits[0]).toContain("before fail-open");
    expect(waits[0]).toContain("slots=1 maxBusy=0.60");
  });

  it("samples real CPU when no signal is injected", async () => {
    clearTuningEnv();
    const lockDir = freshDir();
    // No cpuBusy override: exercises the os.cpus() tick sampler for real. The
    // ceiling is lifted above 1 so the assertion cannot depend on host load.
    const lease = track(await acquireGateLease({ lockDir, maxBusy: 1.01, sampleMs: 5 }));
    expect(lease.held).toBe(true);
  });
});

describe("acquireGateLease edge cases", () => {
  it("is a no-op when slots <= 0 (disabled)", async () => {
    const lockDir = freshDir();
    const lease = await acquireGateLease({ lockDir, ...defaults({ slots: 0 }) });
    expect(lease.held).toBe(false);
    expect(lease.slot).toBeNull();
    lease.release(); // must not throw
  });

  it("release is idempotent and frees the slot for re-acquisition", async () => {
    const lockDir = freshDir();
    const a = await acquireGateLease({ lockDir, ...defaults() });
    a.release();
    a.release(); // idempotent

    const b = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(b.held).toBe(true);
    expect(b.slot).toBe(0);
  });

  it("fails open with a warning when the lock dir cannot be created", async () => {
    // Point lockDir at a path under a regular file so mkdir throws ENOTDIR.
    const base = freshDir();
    const filePath = join(base, "not-a-dir");
    writeFileSync(filePath, "x");
    const lockDir = join(filePath, "gate-locks");

    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir, ...defaults({ logger: { warn: (m) => warnings.push(m) } }) });
    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("could not create lock dir") && w.includes("fail-open"))).toBe(true);
    lease.release(); // must not throw
  });
});

describe("gate-lease env tuning", () => {
  it("caps MCX_GATE_LEASE_SLOTS to the max and warns", async () => {
    const opts = defaults();
    process.env.MCX_GATE_LEASE_SLOTS = "999999";
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({ lockDir: freshDir(), ...opts, logger: { warn: (m) => warnings.push(m) } }),
    );
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("exceeds max") && w.includes("capping"))).toBe(true);
  });

  it("warns and falls back for a non-integer MCX_GATE_LEASE_SLOTS", async () => {
    const opts = defaults();
    process.env.MCX_GATE_LEASE_SLOTS = "2abc";
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({ lockDir: freshDir(), ...opts, logger: { warn: (m) => warnings.push(m) } }),
    );
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("is not an integer"))).toBe(true);
  });

  it("warns when a negative MCX_GATE_LEASE_SLOTS disables the gate", async () => {
    const opts = defaults();
    process.env.MCX_GATE_LEASE_SLOTS = "-1";
    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir: freshDir(), ...opts, logger: { warn: (m) => warnings.push(m) } });
    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("disables the gate"))).toBe(true);
  });

  it("skips the headroom wait when MCX_GATE_LEASE_MAX_BUSY is 0", async () => {
    const opts = defaults({ cpuBusy: () => 0.99 });
    process.env.MCX_GATE_LEASE_MAX_BUSY = "0";
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({ lockDir: freshDir(), ...opts, logger: { warn: (m) => warnings.push(m) } }),
    );
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("disables the headroom wait"))).toBe(true);
  });

  it("warns and falls back for a non-numeric MCX_GATE_LEASE_MAX_BUSY", async () => {
    const opts = defaults();
    process.env.MCX_GATE_LEASE_MAX_BUSY = "busy";
    const warnings: string[] = [];
    const lease = track(
      await acquireGateLease({ lockDir: freshDir(), ...opts, logger: { warn: (m) => warnings.push(m) } }),
    );
    expect(lease.held).toBe(true);
    expect(warnings.some((w) => w.includes("is not a number"))).toBe(true);
  });

  it("honours MCX_GATE_LEASE_WAIT_MS as the whole-run fail-open bound", async () => {
    const lockDir = freshDir();
    const blocker = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(blocker.held).toBe(true);

    const opts = defaults();
    process.env.MCX_GATE_LEASE_WAIT_MS = "700";
    const warnings: string[] = [];
    const lease = await acquireGateLease({ lockDir, ...opts, logger: { warn: (m) => warnings.push(m) } });
    expect(lease.held).toBe(false);
    expect(warnings.some((w) => w.includes("no admission within 700ms"))).toBe(true);
  });

  it("rejects a MCX_GATE_LEASE_WAIT_MS with units instead of reading it as milliseconds", async () => {
    // "120s" through a bare parseInt is 120 — a 120ms budget, i.e. the gate
    // silently off. It has to be refused loudly, like the slots reader does.
    const lockDir = freshDir();
    const blocker = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(blocker.held).toBe(true);

    const opts = defaults();
    process.env.MCX_GATE_LEASE_WAIT_MS = "120s";
    const warnings: string[] = [];
    let ticks = 0;
    const lease = await acquireGateLease({
      lockDir,
      ...opts,
      now: () => ticks,
      sleep: async (ms) => {
        ticks += ms;
      },
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(warnings.some((w) => w.includes('MCX_GATE_LEASE_WAIT_MS="120s"') && w.includes("not an integer"))).toBe(
      true,
    );
    // Fell back to the 300s default rather than a 120ms non-wait.
    expect(lease.held).toBe(false);
    expect(ticks).toBeGreaterThan(200_000);
  });

  it("caps MCX_GATE_LEASE_WAIT_MS so the wait plus the run it admits cannot breach the 600s worker timeout", async () => {
    const lockDir = freshDir();
    const blocker = track(await acquireGateLease({ lockDir, ...defaults() }));
    expect(blocker.held).toBe(true);

    const opts = defaults();
    process.env.MCX_GATE_LEASE_WAIT_MS = String(15 * 60 * 1000);
    const warnings: string[] = [];
    let ticks = 0;
    const lease = await acquireGateLease({
      lockDir,
      ...opts,
      now: () => ticks,
      sleep: async (ms) => {
        ticks += ms;
      },
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(warnings.some((w) => w.includes("exceeds max 400000ms") && w.includes("600s worker timeout"))).toBe(true);
    expect(lease.held).toBe(false);
    // Capped: it waited the 400s max, not the 15 minutes requested.
    expect(ticks).toBeLessThanOrEqual(400_000 + 1000);
  });
});
