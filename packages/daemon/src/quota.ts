/**
 * Proactive quota monitoring via Claude Code's OAuth usage endpoint.
 *
 * Polls GET https://api.anthropic.com/api/oauth/usage with the Claude Code
 * session OAuth token to track utilization across 5-hour and 7-day windows.
 * Requires `anthropic-beta: oauth-2025-04-20` header.
 */

import type { Logger } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import { type ClaudeOAuthToken, readClaudeOAuthToken } from "./auth/keychain";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;

/** A single usage bucket from the API response. */
export interface UsageBucket {
  /** Percentage used (0-100). */
  utilization: number;
  /** ISO 8601 timestamp when this window resets. */
  resetsAt: string;
}

/** Extra usage / overage bucket. */
export interface ExtraUsageBucket {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  /** Percentage of extra usage budget consumed (0-100). */
  utilization: number;
}

/** Parsed quota status from the usage endpoint. */
export interface QuotaStatus {
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  sevenDaySonnet: UsageBucket | null;
  sevenDayOpus: UsageBucket | null;
  extraUsage: ExtraUsageBucket | null;
  /** When this data was fetched. */
  fetchedAt: number;
}

/** Raw JSON shape from the API. */
interface RawUsageResponse {
  five_hour?: { utilization: number; resets_at: string } | null;
  seven_day?: { utilization: number; resets_at: string } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
  seven_day_opus?: { utilization: number; resets_at: string } | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
  } | null;
}

function parseBucket(raw: { utilization: number; resets_at: string } | null | undefined): UsageBucket | null {
  if (!raw) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at };
}

function parseExtraUsage(
  raw: { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number } | null | undefined,
): ExtraUsageBucket | null {
  if (!raw) return null;
  return {
    isEnabled: raw.is_enabled,
    monthlyLimit: raw.monthly_limit,
    usedCredits: raw.used_credits,
    utilization: raw.utilization,
  };
}

/** Parse the raw API response into a QuotaStatus. */
export function parseUsageResponse(raw: RawUsageResponse): QuotaStatus {
  return {
    fiveHour: parseBucket(raw.five_hour),
    sevenDay: parseBucket(raw.seven_day),
    sevenDaySonnet: parseBucket(raw.seven_day_sonnet),
    sevenDayOpus: parseBucket(raw.seven_day_opus),
    extraUsage: parseExtraUsage(raw.extra_usage),
    fetchedAt: Date.now(),
  };
}

/** Fetch quota usage from the Anthropic OAuth usage endpoint. */
export async function fetchQuotaUsage(token: ClaudeOAuthToken): Promise<QuotaStatus> {
  const resp = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
      "User-Agent": "mcp-cli/1.0",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Quota API returned ${resp.status}: ${body}`);
  }

  const raw: RawUsageResponse = await resp.json();
  return parseUsageResponse(raw);
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WARN_THRESHOLD = 80;
const CRITICAL_THRESHOLD = 95;

/** Periodic quota poller. Fetches usage on an interval and logs warnings. */
export class QuotaPoller {
  private timer: Timer | null = null;
  private _status: QuotaStatus | null = null;
  private _lastError: string | null = null;
  private _errorLogged = false;
  private logger: Logger;
  private intervalMs: number;
  /** Injected token reader for testing. */
  private readToken: () => Promise<ClaudeOAuthToken | null>;
  /** Injected fetch function for testing. */
  private fetchUsage: (token: ClaudeOAuthToken) => Promise<QuotaStatus>;

  constructor(options?: {
    logger?: Logger;
    intervalMs?: number;
    readToken?: () => Promise<ClaudeOAuthToken | null>;
    fetchUsage?: (token: ClaudeOAuthToken) => Promise<QuotaStatus>;
  }) {
    this.logger = options?.logger ?? consoleLogger;
    this.intervalMs = options?.intervalMs ?? (Number(process.env.MCP_QUOTA_POLL_INTERVAL) || DEFAULT_POLL_INTERVAL_MS);
    this.readToken = options?.readToken ?? readClaudeOAuthToken;
    this.fetchUsage = options?.fetchUsage ?? fetchQuotaUsage;
  }

  /** Current quota status (null if not yet fetched or unavailable). */
  get status(): QuotaStatus | null {
    return this._status;
  }

  /** Last error message (null if last fetch succeeded). */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Start polling. Does an immediate first fetch. */
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const token = await this.readToken();
      if (!token) {
        // No token available — skip silently (CI, non-Claude-Code env)
        return;
      }

      const status = await this.fetchUsage(token);
      this._status = status;
      this._lastError = null;
      this._errorLogged = false;

      this.checkThresholds(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      // Log once on first failure, then stay silent to avoid spam
      if (!this._errorLogged) {
        this.logger.warn(`[mcpd] Quota fetch failed: ${msg}`);
        this._errorLogged = true;
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
