/**
 * Proactive quota monitoring via Claude Code's OAuth usage endpoint.
 *
 * Fetch + parse live in @mcp-cli/core (command calls them too). This module is
 * the poller, plus a best-effort stamp of the result onto the active auth profile
 * so `mcx claude auth ls` can show quota without talking to the daemon.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger, QuotaExtraUsage, QuotaStatus, QuotaUsageBucket, StoredQuota } from "@mcp-cli/core";
import { consoleLogger, fetchQuotaUsage, options, parseUsageResponse, toStoredQuota } from "@mcp-cli/core";
import { type ClaudeOAuthToken, readClaudeSessionToken } from "./auth/keychain";
import { safeSetTimeout } from "./safe-timers";

export type { QuotaStatus, StoredQuota };
export type UsageBucket = QuotaUsageBucket;
export type ExtraUsageBucket = QuotaExtraUsage;
export { fetchQuotaUsage, parseUsageResponse, toStoredQuota };

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ACTIVE_FILE = "active.json";
const FILE_MODE = 0o600;

/**
 * Best-effort: write `quota` onto the currently-active oauth auth profile.
 *
 * Does not create the profile store, does not take the auth operation lock, and
 * never throws — a missed stamp is preferable to blocking the poller or tearing
 * a credential file. Concurrent `auth save/load` wins the race via atomic rename.
 *
 * Returns whether a profile file was written.
 */
export function stampActiveProfileQuota(quota: StoredQuota, profilesDir: string = options.AUTH_PROFILES_DIR): boolean {
  try {
    const activePath = join(profilesDir, ACTIVE_FILE);
    if (!existsSync(activePath)) return false;

    const activeRaw: unknown = JSON.parse(readFileSync(activePath, "utf-8"));
    if (typeof activeRaw !== "object" || activeRaw === null || Array.isArray(activeRaw)) return false;
    const active = activeRaw as Record<string, unknown>;
    if (typeof active.pending === "string") return false;
    const name = active.profile;
    if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) return false;

    const profilePath = join(profilesDir, `${name}.json`);
    if (!existsSync(profilePath)) return false;

    const profileRaw: unknown = JSON.parse(readFileSync(profilePath, "utf-8"));
    if (typeof profileRaw !== "object" || profileRaw === null || Array.isArray(profileRaw)) return false;
    const profile = profileRaw as Record<string, unknown>;
    if (profile.kind === "api-key") return false;

    profile.quota = quota;
    writeProfileAtomic(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    return true;
  } catch {
    // Advisory snapshot — never fail the poller for a profile-store hiccup.
    return false;
  }
}

function writeProfileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const fd = openSync(tmp, "w", FILE_MODE);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour cap on rate-limit backoff
const WARN_THRESHOLD = 80;
const CRITICAL_THRESHOLD = 95;

/** Detect whether an error looks like a rate-limit response (HTTP 429 or Anthropic rate_limit_error). */
function isRateLimitError(msg: string): boolean {
  return msg.includes("429") || msg.includes("rate_limit_error") || /rate[- ]?limit/i.test(msg);
}

/** Periodic quota poller. Fetches usage on an interval and logs warnings. */
export class QuotaPoller {
  private timer: Timer | null = null;
  private running = false;
  private _status: QuotaStatus | null = null;
  private _lastError: string | null = null;
  private _lastAttemptAt: number | null = null;
  private _errorLogged = false;
  private _lastErrorType: "rate-limit" | "other" | null = null;
  private _backoffMs: number | null = null;
  private logger: Logger;
  private intervalMs: number;
  /** Injected token reader for testing. */
  private readToken: () => Promise<ClaudeOAuthToken | null>;
  /** Injected fetch function for testing. */
  private fetchUsage: (token: ClaudeOAuthToken) => Promise<QuotaStatus>;
  /** Injected active-profile stamp. Defaults to stampActiveProfileQuota. */
  private stampProfile: (quota: StoredQuota) => void;

  constructor(opts?: {
    logger?: Logger;
    intervalMs?: number;
    readToken?: () => Promise<ClaudeOAuthToken | null>;
    fetchUsage?: (token: ClaudeOAuthToken) => Promise<QuotaStatus>;
    stampProfile?: (quota: StoredQuota) => void;
  }) {
    this.logger = opts?.logger ?? consoleLogger;
    this.intervalMs = opts?.intervalMs ?? (Number(process.env.MCP_QUOTA_POLL_INTERVAL) || DEFAULT_POLL_INTERVAL_MS);
    this.readToken = opts?.readToken ?? readClaudeSessionToken;
    this.fetchUsage = opts?.fetchUsage ?? fetchQuotaUsage;
    this.stampProfile =
      opts?.stampProfile ??
      ((quota) => {
        stampActiveProfileQuota(quota);
      });
  }

  /** Current quota status (null if not yet fetched or unavailable). */
  get status(): QuotaStatus | null {
    return this._status;
  }

  /** Last error message (null if last fetch succeeded). */
  get lastError(): string | null {
    return this._lastError;
  }

  /**
   * When the poller last attempted a fetch (ms epoch), regardless of outcome. Null
   * before the first tick. Lets a consumer (e.g. `_metrics quota_status`) distinguish
   * "the poller genuinely hasn't run yet" from "it has been running and still has
   * nothing" — see `poll()` for why the latter doesn't set `lastError` on its own.
   */
  get lastAttemptAt(): number | null {
    return this._lastAttemptAt;
  }

  /** Current backoff delay in ms (null if not backing off). Exposed for testing/observability. */
  get backoffMs(): number | null {
    return this._backoffMs;
  }

  /** Start polling. Does an immediate first fetch. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** Stop polling. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.poll();
    if (!this.running) return;
    const delay = this._backoffMs ?? this.intervalMs;
    this.timer = safeSetTimeout(() => this.tick(), delay);
  }

  private async poll(): Promise<void> {
    this._lastAttemptAt = Date.now();
    try {
      const token = await this.readToken();
      if (!token) {
        // No token available — skip silently (CI, non-Claude-Code env). `lastAttemptAt`
        // still advances so a consumer can tell "never started" from "tried and found
        // nothing" without this turning into a logged error on every poll.
        return;
      }

      const status = await this.fetchUsage(token);
      this._status = status;
      this._lastError = null;
      this._errorLogged = false;
      this._lastErrorType = null;
      this._backoffMs = null;

      try {
        this.stampProfile(toStoredQuota(status));
      } catch (err) {
        this.logger.debug(`[mcpd] Quota profile stamp skipped: ${err instanceof Error ? err.message : String(err)}`);
      }

      this.checkThresholds(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;

      const errorType = isRateLimitError(msg) ? "rate-limit" : "other";
      if (this._lastErrorType !== errorType) {
        this._errorLogged = false;
      }
      this._lastErrorType = errorType;

      if (errorType === "rate-limit") {
        const next = this._backoffMs == null ? this.intervalMs * 2 : this._backoffMs * 2;
        this._backoffMs = Math.min(next, MAX_BACKOFF_MS);
        if (!this._errorLogged) {
          this.logger.warn(`[mcpd] Quota rate-limited; backing off to ${Math.round(this._backoffMs / 1000)}s: ${msg}`);
          this._errorLogged = true;
        }
      } else {
        this._backoffMs = null;
        if (!this._errorLogged) {
          this.logger.warn(`[mcpd] Quota fetch failed: ${msg}`);
          this._errorLogged = true;
        }
      }
    }
  }

  private checkThresholds(status: QuotaStatus): void {
    const fh = status.fiveHour;
    if (!fh) return;

    if (fh.utilization > CRITICAL_THRESHOLD) {
      this.logger.warn(
        `[mcpd] Quota CRITICAL: 5h usage at ${fh.utilization}%, resets at ${fh.resetsAt}. Pausing new sessions recommended.`,
      );
    } else if (fh.utilization > WARN_THRESHOLD) {
      this.logger.warn(`[mcpd] Quota warning: 5h usage at ${fh.utilization}%, resets at ${fh.resetsAt}`);
    }
  }
}
