/**
 * Cooperative gate-run lease — host-global admission control for `am-i-done`.
 *
 * Problem (#2690): N `mcx claude` worker sessions each run `bun run am-i-done`
 * concurrently. Each `bun test --parallel` fans out ~cpu-count worker threads,
 * so N sessions × cpu-count threads oversubscribe the host and the OS starts
 * SIGTERM-ing Bun test workers mid-run — an instant mass kill across unrelated
 * spec files that reads like a flaky suite but is pure resource arithmetic.
 *
 * The fix is to QUEUE heavy test phases, never to cap/kill/reap workers (the
 * banned sprint 69/70 pattern, #2637). Everything here happens on the way *in*;
 * nothing is ever signalled, killed or reaped (the banned #2597/#2632 pattern).
 *
 * ## Admission, and what is actually guaranteed
 *
 * Two host-shared flock-guarded resources:
 *
 *   - `admit.lock` — a single mutex held for the duration of one *admission
 *     decision*. Exactly one process host-wide is ever deciding whether to
 *     start, so decisions are strictly serialized: runs enter one at a time.
 *   - `slot-<i>.lock` — K counting slots, held for the duration of the run.
 *     Bounds how many gate runs *execute* concurrently.
 *
 * A run is admitted when it holds the admission token, a slot is free, and the
 * host has CPU headroom. Guarantees, all of which hold at the default K:
 *
 *   1. At most K gate runs execute concurrently.
 *   2. Admission decisions are totally ordered — no two runs evaluate headroom
 *      at the same time, so they cannot both clear the same stale reading.
 *   3. Each decision observes the previously admitted run's fan-out, because
 *      the signal is instantaneous (see below) and a decision that follows an
 *      occupied slot waits `settleMs` before sampling.
 *
 * A slot is held only by a run that is *working*: a run waiting for headroom
 * releases its slot and waits on the admission token instead. So a queued run
 * never waits behind a peer that is itself only waiting.
 *
 * ## Why CPU-busy, not loadavg
 *
 * The signal is the instantaneous busy fraction of all cores, sampled from
 * `os.cpus()` cumulative tick deltas over `sampleMs`. The previous version used
 * `os.loadavg()[0]`, which is wrong here twice over. Measured on the 16-core
 * reference host during a sprint (#2949 review):
 *
 *     loadavg = 26.53 / 25.21 / 23.02      busy = 25.6%   (≈4.1 of 16 cores)
 *
 * i.e. loadavg reported 166% of core count while 74% of the CPU sat idle — it
 * counts D-state I/O waiters and is inflated by ~50 mostly-API-blocked agent
 * sessions. Any ceiling expressed as a fraction of cores is unreachable on that
 * host, so every admission burned its whole budget and then ran anyway. It also
 * lags: a 1-minute EWMA reaches ~40% of a peer's steady-state fan-out after 30s,
 * so guarantee 3 above would have needed a ~60s settle instead of ~2s.
 *
 * ## Bounded, whole-run budget
 *
 * `waitMs` is a single budget covering the *entire* admission (token + slot +
 * headroom), charged once per run, not once per step. On expiry the run proceeds
 * anyway — with a slot if one is free, unleased otherwise. Two hard constraints
 * set the default: workers run `am-i-done` under a 600s foreground timeout, and
 * a green run takes ~100-200s, so the admission budget must be well under 400s
 * or the gate manufactures the very phantom failures it exists to prevent.
 * Oversubscribing slightly is strictly better than hanging the gate behind a
 * wedged holder or a permanently-busy host. Waits and fail-opens are logged so
 * contention stays observable.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import { options } from "./constants";
import { flockUnlock, tryFlockExclusive } from "./flock";

/**
 * Concurrent gate runs allowed by default.
 *
 * #2690 asked for a core-derived count, `max(1, floor(cores/4))`. There is no
 * defensible derivation, because a gate run's fan-out is *already* sized to the
 * host: `bun test --parallel` starts ~cpu-count workers, so one run wants the
 * whole machine whatever the machine is. Measured on the 16-core reference host,
 * sampling CPU busy every second through a real `am-i-done` (#2949):
 *
 *     baseline (agent sessions only)   25-33%
 *     during test-parallel             44 → 88% peak, 76-83% sustained ~20s
 *
 * One fan-out therefore consumes ~75-85% of the box on top of a 25% baseline, so
 * a second concurrent fan-out does not fit at any core count a fan-out scales to.
 * The issue's `cores/4` would have admitted *four*.
 *
 * So the default is 1, and the K > 1 machinery exists only for
 * MCX_GATE_LEASE_SLOTS. This is deliberately the same effective concurrency as
 * the `/tmp/mcx-am-i-done.lock` stopgap it is meant to replace — which measured
 * load 27 → 14 — but host-wide, crash-safe via flock, with a CPU-headroom check
 * on top, and with no lock directory to strand when a run dies.
 */
const DEFAULT_SLOTS = 1;
/** Upper bound on slots — a huge value would exhaust the fd table per poll. */
const MAX_SLOTS = 64;
/**
 * Default admission ceiling, as a busy fraction of total CPU capacity.
 *
 * Chosen so that (a) a host loaded only by idle-ish agent sessions admits — the
 * reference host measured 25.6% busy while loadavg claimed 26.5 — and (b) a host
 * already running one gate fan-out does not. `bun test --parallel` saturates
 * most cores, so a run in progress reads well above this and the next decision
 * correctly waits for it. Expressed as a fraction, so a 1- or 2-core host gets a
 * meaningful ceiling instead of the unsatisfiable `max(1, cores * 0.75)` the
 * loadavg version produced.
 */
const DEFAULT_MAX_BUSY = 0.6;
/**
 * Whole-run admission budget before fail-open. See the file header: bounded well
 * below the 600s worker timeout that wraps the gate run this admits.
 */
const DEFAULT_WAIT_MS = 120 * 1000;
/** Base poll interval; jitter is added on top to avoid lockstep retries. */
const DEFAULT_POLL_MS = 250;
/** CPU sampling window. Long enough to be stable, short enough to be free. */
const DEFAULT_SAMPLE_MS = 250;
/**
 * Delay before the first CPU sample when a peer already holds a slot, so a run
 * admitted moments ago is visible in the sample rather than being decided
 * against a pre-fan-out reading. Paid only when a slot is occupied, so the solo
 * case — the common one — pays nothing.
 */
const DEFAULT_SETTLE_MS = 2000;
/** Re-announce an ongoing wait on this interval so it never reads as a wedge. */
const REWARN_MS = 30 * 1000;
/** The single admission mutex, serializing decisions across all gate runs. */
const ADMIT_LOCK = "admit.lock";

/** Minimal logger surface — kept local so core doesn't depend on the runner's. */
export interface LeaseLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface GateLeaseOptions {
  /**
   * Concurrent slots. Defaults to MCX_GATE_LEASE_SLOTS, else 1 (see
   * DEFAULT_SLOTS). `<= 0` disables the gate entirely.
   */
  slots?: number;
  /** Host-shared lock directory. Defaults to ~/.mcp-cli/gate-locks. */
  lockDir?: string;
  /**
   * Whole-run admission budget (ms) covering token + slot + headroom waits.
   * Defaults to MCX_GATE_LEASE_WAIT_MS or 120s.
   */
  waitMs?: number;
  /**
   * CPU busy-fraction ceiling for admission (0-1). Defaults to
   * MCX_GATE_LEASE_MAX_BUSY, else 0.6. `<= 0` skips the headroom wait.
   */
  maxBusy?: number;
  /** Base poll interval (ms) while waiting for admission. */
  pollIntervalMs?: number;
  /** CPU sampling window (ms). */
  sampleMs?: number;
  /** Settle delay (ms) before sampling when a peer already holds a slot. */
  settleMs?: number;
  logger?: LeaseLogger;
  /** DI seam: sleep implementation (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** DI seam: monotonic clock (defaults to performance.now; injected in tests). */
  now?: () => number;
  /** DI seam: jitter source (injected in tests). */
  random?: () => number;
  /** DI seam: CPU busy fraction 0-1 (defaults to an os.cpus() tick sample). */
  cpuBusy?: () => number | Promise<number>;
}

export interface GateLease {
  /** True when an actual slot was held; false when disabled or fail-open. */
  readonly held: boolean;
  /** Index of the slot held, or null when not held. */
  readonly slot: number | null;
  /** Release the slot. Idempotent. */
  release(): void;
}

const UNHELD_LEASE: GateLease = { held: false, slot: null, release: () => {} };

function readSlotsFromEnv(logger?: LeaseLogger): number {
  const fallback = DEFAULT_SLOTS;
  const raw = process.env.MCX_GATE_LEASE_SLOTS;
  if (raw === undefined || raw === "") return fallback;
  // parseInt silently truncates trailing garbage ("2abc" -> 2), which hides a
  // typo in a tuning value — reject non-integers with a warning instead.
  if (!/^\s*-?\d+\s*$/.test(raw)) {
    logger?.warn?.(`gate-lease: MCX_GATE_LEASE_SLOTS="${raw}" is not an integer — using default ${fallback} (#2690)`);
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n > MAX_SLOTS) {
    logger?.warn?.(`gate-lease: MCX_GATE_LEASE_SLOTS=${n} exceeds max ${MAX_SLOTS} — capping to ${MAX_SLOTS} (#2690)`);
    return MAX_SLOTS;
  }
  if (n <= 0) {
    logger?.warn?.(`gate-lease: MCX_GATE_LEASE_SLOTS=${n} disables the gate — proceeding unleased (#2690)`);
  }
  return n;
}

function readWaitFromEnv(): number {
  const raw = process.env.MCX_GATE_LEASE_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_WAIT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAIT_MS;
}

function readMaxBusyFromEnv(logger?: LeaseLogger): number {
  const raw = process.env.MCX_GATE_LEASE_MAX_BUSY;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BUSY;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    logger?.warn?.(
      `gate-lease: MCX_GATE_LEASE_MAX_BUSY="${raw}" is not a number — using default ${DEFAULT_MAX_BUSY} (#2690)`,
    );
    return DEFAULT_MAX_BUSY;
  }
  if (n <= 0) {
    logger?.warn?.(
      `gate-lease: MCX_GATE_LEASE_MAX_BUSY=${n} disables the headroom wait — admitting immediately (#2690)`,
    );
  }
  return n;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(base: number, random: () => number): number {
  return base + Math.floor(random() * base);
}

/** Aggregate (idle, total) CPU ticks across all cores. */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/**
 * Instantaneous busy fraction of all cores over `windowMs`.
 *
 * Unlike loadavg this reflects a peer's fan-out within a second of it starting,
 * and ignores non-CPU waiters (disk, `mds`, network) that cannot contend for the
 * resource the gate protects.
 */
async function sampleCpuBusy(windowMs: number, sleep: (ms: number) => Promise<void>): Promise<number> {
  const a = cpuTicks();
  await sleep(windowMs);
  const b = cpuTicks();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  const busy = 1 - (b.idle - a.idle) / total;
  return Math.min(1, Math.max(0, busy));
}

interface HeldSlot {
  index: number;
  fd: number;
}

/** Open a lock file, or null on a transient fs error (treated as unusable). */
function openLockFile(lockDir: string, name: string): number | null {
  try {
    return openSync(join(lockDir, name), "w");
  } catch {
    return null;
  }
}

/**
 * Probe every slot, retaining the first free one.
 *
 * Safe to lock-then-unlock the slots we don't keep, because this only ever runs
 * while holding the admission token: no peer can be acquiring a slot
 * concurrently, so a momentarily-taken-then-released slot is unobservable.
 */
function probeSlots(lockDir: string, slots: number): { mine: HeldSlot | null; occupied: number } {
  let mine: HeldSlot | null = null;
  let occupied = 0;
  for (let i = 0; i < slots; i++) {
    const fd = openLockFile(lockDir, `slot-${i}.lock`);
    if (fd === null) continue;
    let locked = false;
    try {
      locked = tryFlockExclusive(fd);
    } catch {
      // Unexpected flock error on this fd — release it and try the next slot.
      closeSync(fd);
      continue;
    }
    if (!locked) {
      occupied++;
      closeSync(fd);
      continue;
    }
    if (mine === null) {
      mine = { index: i, fd };
    } else {
      flockUnlock(fd);
      closeSync(fd);
    }
  }
  return { mine, occupied };
}

function releaseSlot(slot: HeldSlot): void {
  flockUnlock(slot.fd);
  closeSync(slot.fd);
}

function makeHeldLease(slot: HeldSlot): GateLease {
  let released = false;
  return {
    held: true,
    slot: slot.index,
    release() {
      if (released) return;
      released = true;
      releaseSlot(slot);
    },
  };
}

interface AdmitContext {
  lockDir: string;
  slots: number;
  maxBusy: number;
  basePoll: number;
  settleMs: number;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  cpuBusy: () => number | Promise<number>;
  logger?: LeaseLogger;
}

/**
 * Announce a wait once, then re-announce every REWARN_MS with elapsed/remaining.
 *
 * warn (not info) because the am-i-done AI file logger mirrors only warn/error
 * to stderr; "why am I not running yet" has to reach the worker or a queued run
 * is indistinguishable from a hung one, and agent sessions intervene on silence.
 */
function makeWaitAnnouncer(ctx: AdmitContext, start: number) {
  let lastAnnounced = Number.NEGATIVE_INFINITY;
  const announce = (what: string): void => {
    announce.waited = true;
    const elapsed = ctx.now() - start;
    if (elapsed - lastAnnounced < REWARN_MS && lastAnnounced !== Number.NEGATIVE_INFINITY) return;
    lastAnnounced = elapsed;
    const remaining = Math.max(0, Math.round(ctx.deadline - ctx.now()));
    const cfg = `slots=${ctx.slots} maxBusy=${ctx.maxBusy.toFixed(2)}`;
    ctx.logger?.warn?.(
      `gate-lease: waiting ${what} — ${Math.round(elapsed)}ms elapsed, ${remaining}ms before fail-open (${cfg}, #2690)`,
    );
  };
  /** Set once any wait has been announced — see the admission log level below. */
  announce.waited = false;
  return announce;
}

/** Hold the single admission mutex, so exactly one run decides at a time. */
async function acquireAdmitToken(ctx: AdmitContext): Promise<{ fd: number; waited: boolean } | null> {
  const start = ctx.now();
  const announce = makeWaitAnnouncer(ctx, start);
  for (;;) {
    const fd = openLockFile(ctx.lockDir, ADMIT_LOCK);
    if (fd !== null) {
      let locked = false;
      try {
        locked = tryFlockExclusive(fd);
      } catch {
        closeSync(fd);
        return null;
      }
      if (locked) return { fd, waited: announce.waited };
      closeSync(fd);
    }
    if (ctx.now() >= ctx.deadline) return null;
    announce("for the admission token (a peer is deciding)");
    await ctx.sleep(jitteredDelay(ctx.basePoll, ctx.random));
  }
}

/**
 * Decide, while holding the admission token: wait for a free slot AND host CPU
 * headroom, then take the slot. Returns null if the budget ran out.
 *
 * A slot found free but rejected on headroom is released again before waiting —
 * slots are held only by runs that are actually working, so a queued peer never
 * blocks behind a waiter.
 */
async function decideAdmission(ctx: AdmitContext, waitedForToken: boolean): Promise<HeldSlot | null> {
  const start = ctx.now();
  const announce = makeWaitAnnouncer(ctx, start);
  announce.waited = waitedForToken;
  let settled = ctx.maxBusy <= 0;

  for (;;) {
    const { mine, occupied } = probeSlots(ctx.lockDir, ctx.slots);
    if (mine) {
      if (ctx.maxBusy <= 0) return mine;
      if (!settled && occupied > 0) {
        // A peer may have been admitted moments ago; give its fan-out time to
        // reach the CPU sample before deciding against a pre-fan-out reading.
        settled = true;
        releaseSlot(mine);
        await ctx.sleep(ctx.settleMs);
        continue;
      }
      const busy = await ctx.cpuBusy();
      if (busy < ctx.maxBusy) {
        const waited = Math.round(ctx.now() - start);
        // A run that queued reports its admission at warn, so the wait and its
        // resolution both survive the am-i-done AI file logger (which mirrors
        // only warn/error and discards the info log on success). An instant
        // admission stays at info — the common case shouldn't cost context.
        const log = announce.waited ? ctx.logger?.warn : ctx.logger?.info;
        log?.(
          `gate-lease: admitted on slot ${mine.index} after ${waited}ms — cpu ${(busy * 100).toFixed(0)}% < ${(ctx.maxBusy * 100).toFixed(0)}%, slots=${ctx.slots} (#2690)`,
        );
        return mine;
      }
      releaseSlot(mine);
      announce(`for cpu headroom (${(busy * 100).toFixed(0)}% busy, need < ${(ctx.maxBusy * 100).toFixed(0)}%)`);
    } else {
      announce(`for a free slot (all ${ctx.slots} busy)`);
    }
    if (ctx.now() >= ctx.deadline) return null;
    await ctx.sleep(jitteredDelay(ctx.basePoll, ctx.random));
  }
}

/**
 * Acquire host-global admission for one gate run: a slot plus CPU headroom.
 *
 * Call once per run, not once per step — the budget is whole-run. Returns an
 * unheld lease when the gate is disabled (`slots <= 0`), when the lock dir is
 * unusable, or when the budget elapses without a slot. Never throws on
 * contention.
 */
export async function acquireGateLease(opts: GateLeaseOptions = {}): Promise<GateLease> {
  const logger = opts.logger;
  const slots = opts.slots ?? readSlotsFromEnv(logger);
  if (slots <= 0) return UNHELD_LEASE;

  const lockDir = opts.lockDir ?? join(options.MCP_CLI_DIR, "gate-locks");
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => performance.now());
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;

  // Fail-open on any fs error creating the lock dir (read-only HOME, disk full,
  // bad permissions) — the lease must never fail the run it wraps (#2690).
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (err) {
    logger?.warn?.(
      `gate-lease: could not create lock dir ${lockDir} (${(err as Error).message}) — proceeding unleased (fail-open, #2690)`,
    );
    return UNHELD_LEASE;
  }

  const waitMs = opts.waitMs ?? readWaitFromEnv();
  const ctx: AdmitContext = {
    lockDir,
    slots,
    maxBusy: opts.maxBusy ?? readMaxBusyFromEnv(logger),
    basePoll: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
    settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
    deadline: now() + waitMs,
    sleep,
    now,
    random: opts.random ?? Math.random,
    cpuBusy: opts.cpuBusy ?? (() => sampleCpuBusy(sampleMs, sleep)),
    logger,
  };

  const token = await acquireAdmitToken(ctx);
  if (token === null) {
    logger?.warn?.(`gate-lease: no admission token within ${waitMs}ms — proceeding unleased (fail-open, #2690)`);
    return UNHELD_LEASE;
  }

  try {
    const slot = await decideAdmission(ctx, token.waited);
    if (slot) return makeHeldLease(slot);

    // Budget spent. Running with a slot is still better than running unleased,
    // so take one if it happens to be free; otherwise proceed uncounted.
    const { mine } = probeSlots(lockDir, slots);
    logger?.warn?.(
      `gate-lease: no admission within ${waitMs}ms — proceeding ${mine ? `on slot ${mine.index}` : "unleased"} (fail-open, #2690)`,
    );
    return mine ? makeHeldLease(mine) : UNHELD_LEASE;
  } finally {
    flockUnlock(token.fd);
    closeSync(token.fd);
  }
}
