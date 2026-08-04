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
 * banned sprint 69/70 pattern, #2637).
 *
 * ## Admission — what it does, and what it does not promise
 *
 * Two host-shared flock-guarded resources:
 *
 *   - `admit.lock` — a single mutex held for the duration of one *admission
 *     decision*. Exactly one process host-wide is ever deciding whether to
 *     start, so two runs cannot both clear the same stale CPU reading.
 *   - `slot-<i>.lock` — K counting slots (default 1), held for the duration of
 *     the run. Bounds how many gate runs *execute* concurrently.
 *
 * A run is admitted when it holds the admission token, a slot is free, and the
 * host has CPU headroom.
 *
 * This is admission control, not a hard limit. The wait is bounded, and on
 * expiry the run proceeds anyway (see the budget section) — so "at most K
 * concurrent runs" describes runs that are still inside their budget, not an
 * invariant. Under contention that outlasts the budget the mechanism degrades
 * from serializing to staggering, deliberately: hanging the gate behind a
 * wedged holder would manufacture the phantom failures #2690 exists to remove.
 *
 * A slot is held only by a run that is *working*: a run rejected on headroom
 * releases its slot before waiting, so a queued run never waits behind a peer
 * that is itself only waiting.
 *
 * ## No cleanup — and why none may be added
 *
 * flock locks are kernel-managed: released automatically on process death (even
 * SIGKILL) or fd close. A crashed holder therefore never strands a slot, and
 * there is deliberately NO STALE-LOCK REAPER TO WRITE. A leftover
 * `slot-*.lock` file is not a leak — the file is meant to persist; only the
 * lock on it is transient. `lsof ~/.mcp-cli/gate-locks/slot-0.lock` shows
 * whether a live process holds it, and if a queue looks stuck the holder is
 * real: measure it, do not reap it. Adding a sweeper, watchdog, timer, killer
 * or unlink here re-creates the sprint 69/70 collapse (#2597/#2632, reverted in
 * #2637). Everything in this file happens on the way *in*; nothing is ever
 * signalled, killed, reaped or unlinked.
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
 * so a peer's fan-out would be invisible for the first ~30s of it.
 *
 * What this signal does NOT see, so nobody reads more into it than it measures:
 * `steal` is not counted, so a noisy-neighbour VM reads as idle; `os.cpus()` is
 * host-wide, so a cgroup-quota'd container misreads in both directions; on
 * asymmetric cores (Apple silicon) saturated E-cores plus idle P-cores average
 * below the ceiling; and memory/IO thrash — the actual mechanism in
 * `false-segfault-orphaned-load.md` and the CI-SIGTERM-at-97% incident — is
 * invisible to it entirely. The slot count, not the CPU check, is what bounds
 * concurrency; headroom is a secondary guard against an already-loaded host.
 *
 * ## Bounded, whole-run budget — and why it is 300s, not 120s
 *
 * `waitMs` is a single budget covering the *entire* admission (token + slot +
 * headroom), charged once per run, not once per step. On expiry the run proceeds
 * anyway — with a slot if one is free, unleased otherwise.
 *
 * The budget has to outlast H, the hold it is waiting for, or it is *worse than
 * doing nothing*: a run that burns its whole budget and then fans out on top of
 * the holder has added latency and removed no concurrency at all. H is the span
 * from the first `lease: true` step to the end of the run, which covers
 * test-parallel → test-control → coverage. Measured (#2949 review round 2):
 *
 *     CI, full suite + coverage ratchet   189s and 194s wall (run 30953980055)
 *     dev host, test-parallel alone       27s (8774 tests, 325 files)
 *
 * So H is ~200s for a green run, and a 120s budget sat *below* it: every
 * co-launched run was guaranteed to wait the full 120s and then oversubscribe
 * anyway. 300s clears a green H with margin, and the ceiling is 400s because
 * budget + H must stay inside the 600s foreground timeout that wraps a worker's
 * gate run — past that the gate manufactures the phantom failures #2690 exists
 * to remove.
 *
 * No budget can outlast an *arbitrary* hold: a wedged holder observed during
 * this review sat on a slot for 47 minutes with 0.3s of CPU (#2973). That is
 * exactly why fail-open exists, and why the honest description of the contended
 * path is "serializes while the holder is normal, staggers when it is not".
 *
 * Fail-open deadlines are jittered per process (DEADLINE_JITTER) so N runs that
 * started together do not all give up in the same poll interval and stampede.
 * Waits, admissions and fail-opens are all logged so contention stays visible.
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
 * Whole-run admission budget before fail-open.
 *
 * This has to outlast the thing it waits for, or it is worse than nothing: a run
 * that burns the whole budget and then fans out on top of the holder has added
 * latency and removed no concurrency. So the budget is sized against H, the
 * measured hold — see "Bounded, whole-run budget" in the file header for H and
 * the 600s arithmetic that caps it.
 */
const DEFAULT_WAIT_MS = 300 * 1000;
/**
 * Upper bound on the admission budget, including via MCX_GATE_LEASE_WAIT_MS.
 * Beyond this, budget + run breaches the 600s foreground worker timeout and the
 * gate starts manufacturing the phantom failures it exists to prevent (#2690).
 */
const MAX_WAIT_MS = 400 * 1000;
/**
 * Fraction of the budget by which each process jitters its own fail-open
 * deadline, DOWNWARD.
 *
 * N runs launched together otherwise share a deadline to within milliseconds and
 * all give up inside one poll interval, converting naturally-staggered arrivals
 * into a synchronised stampede. Downward-only so the configured budget stays a
 * hard ceiling and the 600s arithmetic above still holds.
 */
const DEADLINE_JITTER = 0.25;
/** Base poll interval; jitter is added on top to avoid lockstep retries. */
const DEFAULT_POLL_MS = 250;
/** CPU sampling window. Long enough to be stable, short enough to be free. */
const DEFAULT_SAMPLE_MS = 250;
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
   * Defaults to MCX_GATE_LEASE_WAIT_MS (capped at MAX_WAIT_MS) or 300s. Each
   * process jitters its own effective deadline downward from this.
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

function readWaitFromEnv(logger?: LeaseLogger): number {
  const raw = process.env.MCX_GATE_LEASE_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_WAIT_MS;
  // A bare parseInt reads "120s" as 120 — a 120ms budget, i.e. the gate silently
  // off — and "2m" as 2. Reject anything that isn't a plain integer, loudly.
  if (!/^\s*-?\d+\s*$/.test(raw)) {
    logger?.warn?.(
      `gate-lease: MCX_GATE_LEASE_WAIT_MS="${raw}" is not an integer number of milliseconds — using default ${DEFAULT_WAIT_MS}ms (#2690)`,
    );
    return DEFAULT_WAIT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger?.warn?.(
      `gate-lease: MCX_GATE_LEASE_WAIT_MS=${raw} must be greater than 0 — using default ${DEFAULT_WAIT_MS}ms (#2690)`,
    );
    return DEFAULT_WAIT_MS;
  }
  if (n > MAX_WAIT_MS) {
    logger?.warn?.(
      `gate-lease: MCX_GATE_LEASE_WAIT_MS=${n} exceeds max ${MAX_WAIT_MS}ms — capping to ${MAX_WAIT_MS}ms (a longer wait plus the run it admits would breach the 600s worker timeout, #2690)`,
    );
    return MAX_WAIT_MS;
  }
  return n;
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
 * Take the first free slot, or null when every slot is occupied.
 *
 * Normally called while holding the admission token, so no peer is acquiring a
 * slot concurrently and the lock-then-unlock of slots we don't keep is
 * unobservable. The fail-open path also calls it *without* the token, which is
 * still safe: flock acquisition is atomic, so the worst case is that this run
 * and the token holder both try for the same free slot and exactly one wins.
 */
function probeSlots(lockDir: string, slots: number): HeldSlot | null {
  let mine: HeldSlot | null = null;
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
  return mine;
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
 *
 * `start` is the whole-run admission start, so reported elapsed time covers the
 * token wait too rather than restarting the clock here.
 */
async function decideAdmission(ctx: AdmitContext, start: number, waitedForToken: boolean): Promise<HeldSlot | null> {
  const announce = makeWaitAnnouncer(ctx, start);
  announce.waited = waitedForToken;

  for (;;) {
    // Held across the try so an unexpected throw (cpuBusy, sleep, a logger)
    // cannot leave a slot flocked for the lifetime of the process — that would
    // burn a slot permanently, which no reaper is allowed to clean up.
    let mine = probeSlots(ctx.lockDir, ctx.slots);
    try {
      if (mine) {
        if (ctx.maxBusy <= 0) return mine;
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
        mine = null;
        announce(`for cpu headroom (${(busy * 100).toFixed(0)}% busy, need < ${(ctx.maxBusy * 100).toFixed(0)}%)`);
      } else {
        announce(`for a free slot (all ${ctx.slots} busy)`);
      }
    } catch (err) {
      if (mine) releaseSlot(mine);
      throw err;
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

  const random = opts.random ?? Math.random;
  const waitMs = opts.waitMs ?? readWaitFromEnv(logger);
  // Each process shortens its own budget by up to DEADLINE_JITTER, so co-launched
  // losers scatter instead of failing open in lockstep.
  const budget = Math.round(waitMs * (1 - DEADLINE_JITTER * random()));
  const start = now();
  const ctx: AdmitContext = {
    lockDir,
    slots,
    maxBusy: opts.maxBusy ?? readMaxBusyFromEnv(logger),
    basePoll: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
    deadline: start + budget,
    sleep,
    now,
    random,
    cpuBusy: opts.cpuBusy ?? (() => sampleCpuBusy(sampleMs, sleep)),
    logger,
  };

  let token: { fd: number; waited: boolean } | null = null;
  try {
    token = await acquireAdmitToken(ctx);
    if (token === null) {
      // Logged separately from the fail-open below only so the two causes stay
      // distinguishable in a log; the outcome is deliberately the same.
      logger?.warn?.(
        `gate-lease: no admission token within ${budget}ms (a peer held the decision mutex the whole time) (#2690)`,
      );
    } else {
      const slot = await decideAdmission(ctx, start, token.waited);
      if (slot) return makeHeldLease(slot);
    }

    // Budget spent — either never winning the token, or winning it and never
    // getting headroom. Both paths land here deliberately: the run that never
    // won the token is the one that waited longest, so it must not get the worse
    // deal. Running with a slot is still better than running unleased, so take
    // one if it happens to be free; otherwise proceed uncounted.
    const mine = probeSlots(lockDir, slots);
    logger?.warn?.(
      `gate-lease: no admission within ${budget}ms — proceeding ${mine ? `on slot ${mine.index}` : "unleased"} (fail-open, #2690)`,
    );
    return mine ? makeHeldLease(mine) : UNHELD_LEASE;
  } catch (err) {
    // The lease must never fail the run it wraps (#2690) — an admission bug must
    // not become a phantom gate failure. Held slots are released by the throwing
    // frame before it rethrows.
    logger?.warn?.(
      `gate-lease: admission failed unexpectedly (${(err as Error).message}) — proceeding unleased (fail-open, #2690)`,
    );
    return UNHELD_LEASE;
  } finally {
    if (token !== null) {
      flockUnlock(token.fd);
      closeSync(token.fd);
    }
  }
}
