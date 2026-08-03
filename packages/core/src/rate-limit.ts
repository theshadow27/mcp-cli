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

  return { count, windowMs: windows * UNIT_MS[unit], source };
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
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  private readonly maxQueue: number;
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

  /** Wait for a slot. Resolves with the milliseconds spent waiting. */
  async acquire(): Promise<number> {
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
        this.prune();
        if (this.grants.length < this.spec.count) {
          this.grants.push(this.now());
          return this.now() - start;
        }
        const waitMs = this.grants[0] + this.spec.windowMs - this.now();
        await this.sleep(waitMs > 0 ? waitMs : 1);
      }
    } finally {
      this.pending--;
      release();
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.spec.windowMs;
    while (this.grants.length > 0 && this.grants[0] <= cutoff) this.grants.shift();
  }
}
