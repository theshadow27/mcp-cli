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
 * Fail-open: if every slot stays busy past a generous deadline, acquire returns
 * an un-held handle and the caller proceeds anyway. Oversubscribing slightly is
 * strictly better than hanging the gate forever behind a wedged holder. Waits
 * and fail-opens are logged so contention is observable.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { options } from "./constants";
import { flockUnlock, tryFlockExclusive } from "./flock";

/** Default number of concurrent heavy test phases allowed across the host. */
const DEFAULT_SLOTS = 2;
/** Defensive cap for env/API tuning; high values can exhaust file descriptors. */
const MAX_SLOTS = 64;
/** Generous fail-open deadline — proceed unleased rather than hang the gate. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Base poll interval; jitter is added on top to avoid lockstep retries. */
const DEFAULT_POLL_MS = 250;

/** Minimal logger surface — kept local so core doesn't depend on the runner's. */
export interface LeaseLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface GateLeaseOptions {
  /** Concurrent slots. Defaults to MCX_GATE_LEASE_SLOTS or 2. `<= 0` disables. */
  slots?: number;
  /** Host-shared lock directory. Defaults to ~/.mcp-cli/gate-locks. */
  lockDir?: string;
  /** Fail-open deadline (ms). Defaults to MCX_GATE_LEASE_TIMEOUT_MS or 15min. */
  timeoutMs?: number;
  /** Base poll interval (ms) while waiting for a free slot. */
  pollIntervalMs?: number;
  logger?: LeaseLogger;
  /** DI seam: sleep implementation (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** DI seam: monotonic-ish clock (injected in tests). */
  now?: () => number;
  /** DI seam: jitter source (injected in tests). */
  random?: () => number;
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
  const raw = process.env.MCX_GATE_LEASE_SLOTS;
  if (raw === undefined || raw === "") return DEFAULT_SLOTS;
  return normalizeSlotCount(Number(raw), logger, `MCX_GATE_LEASE_SLOTS=${raw}`);
}

function normalizeSlotCount(slots: number, logger?: LeaseLogger, source = "slots"): number {
  if (!Number.isInteger(slots)) {
    logger?.warn?.(`gate-lease: invalid ${source}; using default ${DEFAULT_SLOTS} slots (#2760)`);
    return DEFAULT_SLOTS;
  }
  if (slots <= 0) {
    logger?.warn?.(`gate-lease: ${source} disables gate lease (slots <= 0, #2760)`);
    return 0;
  }
  if (slots > MAX_SLOTS) {
    logger?.warn?.(`gate-lease: ${source} exceeds max ${MAX_SLOTS}; capping to ${MAX_SLOTS} slots (#2760)`);
    return MAX_SLOTS;
  }
  return slots;
}

function readTimeoutFromEnv(): number {
  const raw = process.env.MCX_GATE_LEASE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
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

/**
 * Acquire one of K cooperative gate slots, waiting for a free slot if all are
 * busy. Returns immediately with an unheld lease when disabled (`slots <= 0`)
 * or when the fail-open deadline elapses. Never throws on contention.
 */
export async function acquireGateLease(opts: GateLeaseOptions = {}): Promise<GateLease> {
  const logger = opts.logger;
  const slots = opts.slots === undefined ? readSlotsFromEnv(logger) : normalizeSlotCount(opts.slots, logger);
  if (slots <= 0) return UNHELD_LEASE;

  const lockDir = opts.lockDir ?? join(options.MCP_CLI_DIR, "gate-locks");
  const timeoutMs = opts.timeoutMs ?? readTimeoutFromEnv();
  const basePoll = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;

  try {
    mkdirSync(lockDir, { recursive: true });
  } catch {
    logger?.warn?.(`gate-lease: could not create lock dir ${lockDir} — proceeding unleased (fail-open, #2760)`);
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
      return makeHeldLease(slot);
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
