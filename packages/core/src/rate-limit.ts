/**
 * Client-side preventive throttling for MCP servers that enforce aggressive
 * upstream rate limits (Atlassian being the motivating case — see #1590).
 *
 * The daemon mediates every tool call, so it is the only choke point that sees
 * all traffic to a given server regardless of whether the caller is Claude
 * Code firing parallel tool calls, an SDK session, or a direct `mcx call`.
 */

/** Max calls allowed to wait for a slot before further calls are rejected. */
export const DEFAULT_RATE_LIMIT_MAX_QUEUE = 100;

/**
 * setTimeout's 32-bit delay ceiling. A larger delay does not wait longer — it
 * silently clamps to 1ms, so an unclamped wait becomes a hot spin.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Longest window a spec may express. Well inside MAX_TIMER_DELAY_MS so no
 * arithmetic on windowMs can reach the timer ceiling, and long enough that no
 * plausible upstream limit is unexpressible.
 */
export const MAX_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Clamp a delay into the range setTimeout actually honors. */
export function clampTimerDelay(ms: number): number {
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return Math.min(Math.trunc(ms), MAX_TIMER_DELAY_MS);
}

/** A parsed rate limit: `count` calls permitted per `windowMs`. */
export interface RateLimitSpec {
  count: number;
  windowMs: number;
  /** The normalized source string this spec was parsed from, e.g. "3/s". */
  source: string;
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

// "3/s", "30/m", "1000/h", "2/500ms" — the optional window multiplier keeps
// sub-second limits expressible without a second config key.
const RATE_LIMIT_PATTERN = /^(\d+)\s*\/\s*(\d*)\s*(ms|s|m|h)$/i;

function invalid(value: string, detail: string): Error {
  return new Error(
    `Invalid rate limit ${JSON.stringify(value)}: ${detail}. Expected "<count>/<window>", e.g. "3/s", "30/m", "1000/h".`,
  );
}

/** Parse a rate-limit string. Throws with an actionable message when malformed. */
export function parseRateLimit(value: string): RateLimitSpec {
  const source = value.trim();
  const match = RATE_LIMIT_PATTERN.exec(source);
  if (!match) throw invalid(value, "unrecognized format");

  const count = Number(match[1]);
  const windows = match[2] === "" ? 1 : Number(match[2]);
  const unit = match[3].toLowerCase() as keyof typeof UNIT_MS;

  if (count <= 0) throw invalid(value, "count must be greater than zero");
  if (windows <= 0) throw invalid(value, "window must be greater than zero");

  const windowMs = windows * UNIT_MS[unit];
  if (windowMs > MAX_RATE_LIMIT_WINDOW_MS) {
    throw invalid(value, `window ${windowMs}ms exceeds the ${MAX_RATE_LIMIT_WINDOW_MS}ms (24h) maximum`);
  }

  return { count, windowMs, source };
}

/** Env var that throttles a server without editing a shared `.mcp.json`. */
export function rateLimitEnvVar(serverName: string): string {
  return `MCX_RATE_LIMIT_${serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

/**
 * The raw rate-limit string in effect for a server, or "" when unlimited.
 * Config wins over env; a blank config value falls through to env.
 */
export function rateLimitSource(
  serverName: string,
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return configured?.trim() || env[rateLimitEnvVar(serverName)]?.trim() || "";
}

/** Resolve the effective spec for a server, or null when unlimited. */
export function resolveRateLimit(
  serverName: string,
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): RateLimitSpec | null {
  const source = rateLimitSource(serverName, configured, env);
  return source === "" ? null : parseRateLimit(source);
}

/** Thrown when too many calls are already waiting for a slot. */
export class RateLimitQueueFullError extends Error {
  constructor(
    readonly spec: RateLimitSpec,
    readonly maxQueue: number,
    label?: string,
  ) {
    super(
      `Rate limit queue full for ${label ?? "server"} (${maxQueue} calls already waiting on ${spec.source}) — retry later or raise the limit`,
    );
    this.name = "RateLimitQueueFullError";
  }
}

/**
 * Thrown when a slot cannot be granted before the caller's deadline. Rejecting
 * up front is the only safe answer: waiting past the deadline means the caller
 * has already timed out and retried, so performing the call would double-write.
 */
export class RateLimitDeadlineError extends Error {
  constructor(
    readonly spec: RateLimitSpec,
    readonly waitMs: number,
    readonly remainingMs: number,
    label?: string,
  ) {
    super(
      `Rate limit wait for ${label ?? "server"} (${spec.source}) needs ~${Math.round(waitMs)}ms but only ${Math.round(remainingMs)}ms of the caller's deadline remains — call not made`,
    );
    this.name = "RateLimitDeadlineError";
  }
}

/** Thrown when the caller went away while its call was queued for a slot. */
export class RateLimitAbortedError extends Error {
  constructor(
    readonly spec: RateLimitSpec,
    label?: string,
  ) {
    super(`Caller aborted while queued for a rate-limit slot on ${label ?? "server"} (${spec.source}) — call not made`);
    this.name = "RateLimitAbortedError";
  }
}

/** Bounds on how long a caller is willing to be queued. */
export interface AcquireOptions {
  /**
   * Absolute epoch-ms ceiling for admission. A wait that cannot finish by then
   * is rejected instead of performed late.
   */
  deadlineMs?: number;
  /** Aborts the wait when the caller disconnects; the call is never admitted. */
  signal?: AbortSignal;
}

export interface RateLimiterOptions {
  maxQueue?: number;
  /** Included in queue-overflow errors — typically the server name. */
  label?: string;
  /** Clock injection point so tests never depend on wall time. */
  now?: () => number;
  /** Sleep injection point so tests never depend on wall time. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, clampTimerDelay(ms));
    // A limiter wait must never hold the daemon's event loop open at teardown.
    timer.unref?.();
  });
}

/**
 * Sliding-window limiter. Waiters are admitted strictly FIFO via a promise
 * chain, so a burst of parallel calls is spread out in arrival order rather
 * than all racing for the same slot.
 */
export class RateLimiter {
  private readonly grants: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** Waiters allowed before further calls are rejected outright. */
  readonly maxQueue: number;
  private readonly label?: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly spec: RateLimitSpec,
    options: RateLimiterOptions = {},
  ) {
    this.maxQueue = options.maxQueue ?? DEFAULT_RATE_LIMIT_MAX_QUEUE;
    this.label = options.label;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Calls currently waiting for a slot (including the one being admitted). */
  get queueDepth(): number {
    return this.pending;
  }

  /** Fraction of the window's budget consumed, 0..1. */
  utilization(): number {
    this.prune();
    return this.grants.length / this.spec.count;
  }

  /**
   * Wait for a slot. Resolves with the milliseconds spent waiting.
   *
   * With `deadlineMs`, a call that cannot be admitted in time is rejected
   * *before* it takes a queue slot: an abandoned waiter would otherwise hold a
   * slot toward `maxQueue` and push live calls into RateLimitQueueFullError.
   */
  async acquire(options: AcquireOptions = {}): Promise<number> {
    const { deadlineMs, signal } = options;
    if (signal?.aborted) throw new RateLimitAbortedError(this.spec, this.label);

    if (deadlineMs !== undefined) {
      const projectedWaitMs = this.projectWaitMs(this.pending);
      const remainingMs = deadlineMs - this.now();
      if (projectedWaitMs > remainingMs) {
        throw new RateLimitDeadlineError(this.spec, projectedWaitMs, remainingMs, this.label);
      }
    }

    if (this.pending >= this.maxQueue) {
      throw new RateLimitQueueFullError(this.spec, this.maxQueue, this.label);
    }
    this.pending++;
    const start = this.now();
    const predecessor = this.chain;
    let release: () => void = () => {};
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await predecessor;
      for (;;) {
        if (signal?.aborted) throw new RateLimitAbortedError(this.spec, this.label);
        this.prune();
        if (this.grants.length < this.spec.count) {
          this.grants.push(this.now());
          return this.now() - start;
        }
        const waitMs = Math.max(this.grants[0] + this.spec.windowMs - this.now(), 1);
        if (deadlineMs !== undefined && waitMs > deadlineMs - this.now()) {
          throw new RateLimitDeadlineError(this.spec, waitMs, deadlineMs - this.now(), this.label);
        }
        // Clamp independently of the parser: the sleep must stay honorable even
        // if a spec ever reaches here with an out-of-range window.
        await this.sleepOrAbort(clampTimerDelay(waitMs), signal);
      }
    } finally {
      this.pending--;
      release();
    }
  }

  /** Sleep, rejecting early if the caller disconnects mid-wait. */
  private async sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(ms);
    let onAbort: () => void = () => {};
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise<void>((_resolve, reject) => {
          onAbort = () => reject(new RateLimitAbortedError(this.spec, this.label));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * How long a caller arriving behind `waitersAhead` others would wait, by
   * replaying the sliding window forward. Used for admission fail-fast.
   */
  private projectWaitMs(waitersAhead: number): number {
    this.prune();
    const now = this.now();
    const expiries = this.grants.map((g) => g + this.spec.windowMs);
    let free = this.spec.count - expiries.length;
    let admittedAt = now;
    for (let i = 0; i <= waitersAhead; i++) {
      if (free > 0) {
        free--;
        admittedAt = now;
      } else {
        // Timestamps only move forward, so shifting keeps `expiries` sorted.
        admittedAt = Math.max(admittedAt, expiries.shift() ?? now);
      }
      expiries.push(admittedAt + this.spec.windowMs);
    }
    return Math.max(admittedAt - now, 0);
  }

  private prune(): void {
    const cutoff = this.now() - this.spec.windowMs;
    while (this.grants.length > 0 && this.grants[0] <= cutoff) this.grants.shift();
  }
}
