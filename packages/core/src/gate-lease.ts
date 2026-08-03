/**
 * Cooperative gate-run lease — a host-global counting semaphore over flock(2).
 *
 * Problem (#2690): N `mcx claude` worker sessions each run `bun run am-i-done`
 * concurrently. Each `bun test --parallel` fans out ~cpu-count worker threads,
 * so N sessions × cpu-count threads oversubscribe the host and the OS starts
 * SIGTERM-ing Bun test workers mid-run — an instant mass kill across unrelated
 * spec files that reads like a flaky suite but is pure resource arithmetic.
 *
 * The fix is to QUEUE heavy test phases, never to cap/kill/reap workers (the
 * banned sprint 69/70 pattern, #2637). This semaphore lets at most K test
 * phases run at once across ALL worktrees on the host; a phase that can't get a
 * slot waits cooperatively until one frees.
 *
 * Mechanism: K slot files in a host-shared directory, each guarded by an
 * exclusive flock. Acquiring = winning the exclusive lock on any one slot.
 * flock locks are kernel-managed and released automatically on process death
 * (even SIGKILL) or fd close — so a crashed holder never strands a slot and
 * there is no stale-lock reaper to write.
 *
 * Admission has two stages, both on the way *in* — nothing is ever signalled,
 * killed or reaped (the banned #2597/#2632 pattern):
 *
 *   1. Win a slot (bounds the number of concurrent gate runs).
 *   2. Wait for load headroom (bounds total host pressure, including load this
 *      process did not create — N agent sessions, editors, other builds).
 *
 * Stage 2 exists because a slot count alone is blind to non-gate load: one
 * admitted gate run plus ~12 agent sessions measured load 18.9 on a 16-core
 * host, so admitting a second full fan-out on top reaches the ~27 regime where
 * the OS starts killing test workers.
 *
 * Fail-open at both stages: if every slot stays busy past a generous deadline,
 * acquire returns an un-held handle and the caller proceeds anyway; if load
 * never drops, the load wait gives up and the run proceeds holding its slot.
 * Oversubscribing slightly is strictly better than hanging the gate forever
 * behind a wedged holder or a permanently-busy host. Waits and fail-opens are
 * logged so contention is observable.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

import { options } from "./constants";
import { flockUnlock, tryFlockExclusive } from "./flock";

/**
 * Cores per allowed concurrent gate run, used to derive the default slot count.
 *
 * #2690 asked for `max(1, floor(cores/4))`. That is not implemented, because it
 * contradicts the field measurements it was meant to fix: on the 16-core macOS
 * host in the report, `cores/4` yields 4 slots — *more* permissive than the
 * fixed 2 that was already in place and that produced the failures. Measured on
 * that host: one admitted gate run plus ~12 agent sessions = load 18.9 on 16
 * cores, and two concurrent runs reached ~27, the regime where the OS SIGTERMs
 * bun test workers. Dividing by 8 keeps 16 cores at 2 (matching the value the
 * host tolerates when load headroom is also respected — see MAX_LOAD_FACTOR)
 * while correctly dropping 4- and 8-core hosts to 1, which the old hardcoded 2
 * got wrong.
 */
const CORES_PER_SLOT = 8;
/** Upper bound on slots — a huge value would exhaust the fd table per poll. */
const MAX_SLOTS = 64;
/**
 * Default load ceiling as a fraction of core count.
 *
 * Deliberately below 1.0: a gate run's own `bun test --parallel` fan-out adds
 * roughly a core's worth of load per worker, so admitting at exactly `cores`
 * would start a full fan-out on an already-saturated box and land in the
 * failure regime. 0.75 leaves the admitted run somewhere to grow into — on the
 * 16-core reference host that admits at the observed ~8-10 idle baseline and
 * blocks at the ~19 one-run-active reading.
 */
const DEFAULT_MAX_LOAD_FACTOR = 0.75;
/** Generous fail-open deadline — proceed unleased rather than hang the gate. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * Fail-open deadline for the load-headroom wait. Shorter than the slot deadline:
 * a slot frees when a peer finishes, but load on a permanently-busy host may
 * never drop, so degrade to "just run it" sooner.
 */
const DEFAULT_LOAD_WAIT_MS = 5 * 60 * 1000;
/** Base poll interval; jitter is added on top to avoid lockstep retries. */
const DEFAULT_POLL_MS = 250;

/** Minimal logger surface — kept local so core doesn't depend on the runner's. */
export interface LeaseLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface GateLeaseOptions {
  /**
   * Concurrent slots. Defaults to MCX_GATE_LEASE_SLOTS, else derived from the
   * core count as `max(1, floor(cores/8))`. `<= 0` disables the gate entirely.
   */
  slots?: number;
  /** Host-shared lock directory. Defaults to ~/.mcp-cli/gate-locks. */
  lockDir?: string;
  /** Fail-open deadline (ms). Defaults to MCX_GATE_LEASE_TIMEOUT_MS or 15min. */
  timeoutMs?: number;
  /**
   * 1-minute load-average ceiling for admission. Defaults to
   * MCX_GATE_LEASE_MAX_LOAD, else `cores * 0.75`. `<= 0` skips the load wait.
   */
  maxLoad?: number;
  /**
   * Fail-open deadline for the load wait (ms). Defaults to
   * MCX_GATE_LEASE_LOAD_WAIT_MS or 5min.
   */
  loadWaitMs?: number;
  /** Base poll interval (ms) while waiting for a free slot. */
  pollIntervalMs?: number;
  logger?: LeaseLogger;
  /** DI seam: sleep implementation (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** DI seam: monotonic clock (defaults to performance.now; injected in tests). */
  now?: () => number;
  /** DI seam: jitter source (injected in tests). */
  random?: () => number;
  /** DI seam: 1-minute load average (defaults to os.loadavg()[0]). */
  loadAvg?: () => number;
  /** DI seam: logical core count (defaults to os.cpus().length). */
  cpuCount?: () => number;
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

function readSlotsFromEnv(cores: number, logger?: LeaseLogger): number {
  const fallback = Math.max(1, Math.floor(cores / CORES_PER_SLOT));
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

function readTimeoutFromEnv(): number {
  const raw = process.env.MCX_GATE_LEASE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function readMaxLoadFromEnv(cores: number, logger?: LeaseLogger): number {
  const fallback = Math.max(1, cores * DEFAULT_MAX_LOAD_FACTOR);
  const raw = process.env.MCX_GATE_LEASE_MAX_LOAD;
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    logger?.warn?.(`gate-lease: MCX_GATE_LEASE_MAX_LOAD="${raw}" is not a number — using default ${fallback} (#2690)`);
    return fallback;
  }
  if (n <= 0) {
    logger?.warn?.(`gate-lease: MCX_GATE_LEASE_MAX_LOAD=${n} disables the load wait — admitting immediately (#2690)`);
  }
  return n;
}

function readLoadWaitFromEnv(): number {
  const raw = process.env.MCX_GATE_LEASE_LOAD_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_LOAD_WAIT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOAD_WAIT_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(base: number, random: () => number): number {
  return base + Math.floor(random() * base);
}

interface HeldSlot {
  index: number;
  fd: number;
}

/** Try each slot file once; return the first whose exclusive flock we win. */
function tryAcquireAnySlot(lockDir: string, slots: number): HeldSlot | null {
  for (let i = 0; i < slots; i++) {
    const path = join(lockDir, `slot-${i}.lock`);
    let fd: number;
    try {
      fd = openSync(path, "w");
    } catch {
      // Slot file could not be opened (transient fs error) — skip it.
      continue;
    }
    let locked = false;
    try {
      locked = tryFlockExclusive(fd);
    } catch {
      // Unexpected flock error on this fd — release it and try the next slot.
      closeSync(fd);
      continue;
    }
    if (locked) return { index: i, fd };
    closeSync(fd);
  }
  return null;
}

function makeHeldLease(slot: HeldSlot): GateLease {
  let released = false;
  return {
    held: true,
    slot: slot.index,
    release() {
      if (released) return;
      released = true;
      flockUnlock(slot.fd);
      closeSync(slot.fd);
    },
  };
}

interface LoadWaitParams {
  maxLoad: number;
  loadWaitMs: number;
  basePoll: number;
  slotIndex: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  loadAvg: () => number;
  logger?: LeaseLogger;
}

/**
 * Stage 2 of admission: hold the slot until the host has load headroom.
 *
 * Waiting *while holding the slot* is the load-bearing part of this design, not
 * an implementation detail — do not "optimise" it into a wait-then-acquire. The
 * slot makes the load wait mutually exclusive, so at most K runs are ever
 * watching the load average and they enter one at a time. Waiting before
 * acquiring reproduces the convoy this replaces: in sprint 76 three sessions
 * independently polled for load < 6 / < 3 / < 4, all cleared their private
 * thresholds within the same instant, and fired their suites simultaneously —
 * exactly the oversubscription the gate exists to prevent.
 *
 * Bounded fail-open: a permanently-busy host must degrade to "just run it",
 * never hang. The run proceeds still holding its slot.
 */
async function waitForLoadHeadroom(p: LoadWaitParams): Promise<void> {
  if (p.maxLoad <= 0) return;

  const start = p.now();
  const deadline = start + p.loadWaitMs;
  let announced = false;

  for (;;) {
    const load = p.loadAvg();
    if (load < p.maxLoad) {
      if (announced) {
        p.logger?.warn?.(
          `gate-lease: slot ${p.slotIndex} admitted after waiting ${Math.round(p.now() - start)}ms for load ${load.toFixed(2)} < ${p.maxLoad.toFixed(2)} (#2690)`,
        );
      }
      return;
    }
    if (p.now() >= deadline) {
      p.logger?.warn?.(
        `gate-lease: load ${load.toFixed(2)} still above ${p.maxLoad.toFixed(2)} after ${p.loadWaitMs}ms — proceeding anyway (fail-open, #2690)`,
      );
      return;
    }
    if (!announced) {
      announced = true;
      // warn (not info) for the same reason as the slot wait: the am-i-done AI
      // file logger only mirrors warn/error, and "why am I not running yet" has
      // to reach the worker or the run looks hung.
      p.logger?.warn?.(
        `gate-lease: holding slot ${p.slotIndex}, waiting for host load ${load.toFixed(2)} to fall below ${p.maxLoad.toFixed(2)} (#2690)`,
      );
    }
    await p.sleep(jitteredDelay(p.basePoll, p.random));
  }
}

/**
 * Acquire one of K cooperative gate slots, waiting for a free slot if all are
 * busy and then for host load headroom. Returns immediately with an unheld
 * lease when disabled (`slots <= 0`) or when the slot fail-open deadline
 * elapses. Never throws on contention.
 */
export async function acquireGateLease(opts: GateLeaseOptions = {}): Promise<GateLease> {
  const logger = opts.logger;
  const cpuCount = opts.cpuCount ?? (() => cpus().length);
  const cores = Math.max(1, cpuCount());
  const slots = opts.slots ?? readSlotsFromEnv(cores, logger);
  if (slots <= 0) return UNHELD_LEASE;

  const lockDir = opts.lockDir ?? join(options.MCP_CLI_DIR, "gate-locks");
  const timeoutMs = opts.timeoutMs ?? readTimeoutFromEnv();
  const maxLoad = opts.maxLoad ?? readMaxLoadFromEnv(cores, logger);
  const loadWaitMs = opts.loadWaitMs ?? readLoadWaitFromEnv();
  const basePoll = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => performance.now());
  const random = opts.random ?? Math.random;
  const loadAvg = opts.loadAvg ?? (() => loadavg()[0] ?? 0);

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

  const deadline = now() + timeoutMs;
  let announcedWait = false;

  const start = now();

  for (;;) {
    const slot = tryAcquireAnySlot(lockDir, slots);
    if (slot) {
      // warn (not info) so the message survives the am-i-done AI file logger,
      // which mirrors only warn/error to stderr and deletes the info-only log
      // on success — the worker context is exactly where #2690 contention needs
      // to stay observable.
      if (announcedWait) {
        logger?.warn?.(`gate-lease: acquired slot ${slot.index} after waiting ${now() - start}ms (#2690)`);
      }
      const lease = makeHeldLease(slot);
      await waitForLoadHeadroom({
        maxLoad,
        loadWaitMs,
        basePoll,
        slotIndex: slot.index,
        sleep,
        now,
        random,
        loadAvg,
        logger,
      });
      return lease;
    }
    if (now() >= deadline) {
      logger?.warn?.(
        `gate-lease: all ${slots} slots busy past ${timeoutMs}ms — proceeding unleased (fail-open, #2690)`,
      );
      return UNHELD_LEASE;
    }
    if (!announcedWait) {
      announcedWait = true;
      logger?.warn?.(`gate-lease: all ${slots} slots busy — queueing for a free slot (#2690)`);
    }
    await sleep(jitteredDelay(basePoll, random));
  }
}

/**
 * Run `fn` while holding a gate slot, releasing it afterwards even on throw.
 */
export async function withGateLease<T>(fn: () => Promise<T>, opts: GateLeaseOptions = {}): Promise<T> {
  const lease = await acquireGateLease(opts);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}
