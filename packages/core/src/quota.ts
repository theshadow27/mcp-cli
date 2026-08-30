/**
 * Claude OAuth usage endpoint — shared request/response shape plus the plain fetch.
 *
 * The daemon poller and `mcx claude auth save/load` / `ls --fetch` / `ls --fetch-all`
 * all call this. Types live here
 * so command does not depend on @mcp-cli/daemon (the fetch takes only `{accessToken}`).
 */

import type { QuotaExtraUsage, QuotaUsageBucket } from "./ipc";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
export const QUOTA_REQUEST_TIMEOUT_MS = 5_000;
/** Attempts per profile on 429 (the usage endpoint throttles hard). */
export const QUOTA_RATE_LIMIT_MAX_ATTEMPTS = 3;
/** Initial backoff when Retry-After is missing. Doubles each retry. */
export const QUOTA_RATE_LIMIT_BACKOFF_MS = 1_000;
export const QUOTA_RATE_LIMIT_MAX_BACKOFF_MS = 16_000;
/** Cap on a single Retry-After wait. Enforced again at the sleep site, not only here. */
export const QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS = 60_000;
/**
 * Total wall-clock budget for one `ls --fetch-all` sweep, sleeps included.
 *
 * The per-attempt Retry-After cap is not a budget: an intermittently-throttled
 * fleet never exhausts any single profile's retries, so N profiles could
 * accumulate N × attempts × 60s of sleep. This is the bound that actually keeps
 * the sweep from hanging for minutes.
 */
export const QUOTA_FETCH_ALL_BUDGET_MS = 120_000;

/** 429 / Anthropic rate_limit_error from the OAuth usage endpoint. */
export class QuotaRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "QuotaRateLimitError";
  }
}

/**
 * True only for the typed error. `fetchQuotaUsage` already knows the HTTP status at
 * the throw site, so message sniffing buys nothing and misreads a 500 whose
 * `request_id` happens to contain "429", or a 400 that mentions "rate limit tier"
 * in prose — a misclassification costs the whole `--fetch-all` sweep three
 * pointless backoff sleeps and a fleet-wide skip.
 */
export function isQuotaRateLimitError(err: unknown): boolean {
  return err instanceof QuotaRateLimitError;
}

export function quotaRetryAfterMs(err: unknown): number | null {
  return err instanceof QuotaRateLimitError ? err.retryAfterMs : null;
}

/** RFC 7231 delta-seconds: decimal digits only. `Number()` would also take "0x10" and "1e3". */
const DELTA_SECONDS_RE = /^\d+$/;
/** Every RFC 7231 HTTP-date form starts with a day name; nothing else may reach `Date.parse`. */
const HTTP_DATE_START_RE = /^[A-Za-z]/;

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date). Returns milliseconds,
 * capped at QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS. Null when missing or unusable —
 * including a negative delta or a date already in the past, so the caller falls
 * back to exponential backoff instead of retrying with no wait at all.
 */
export function parseRetryAfterHeader(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (DELTA_SECONDS_RE.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS);
  }
  // `Date.parse("-5")` succeeds (year -5) and would otherwise mean "no backoff".
  if (!HTTP_DATE_START_RE.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - nowMs;
  if (delta <= 0) return null;
  return Math.min(delta, QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS);
}

/** Parsed quota status from the usage endpoint. */
export interface QuotaStatus {
  fiveHour: QuotaUsageBucket | null;
  sevenDay: QuotaUsageBucket | null;
  sevenDaySonnet: QuotaUsageBucket | null;
  sevenDayOpus: QuotaUsageBucket | null;
  extraUsage: QuotaExtraUsage | null;
  /** When this data was fetched (ms since epoch). */
  fetchedAt: number;
}

/**
 * Durable per-profile quota snapshot. Same buckets as QuotaStatus, but `capturedAt`
 * is ISO like the sibling `policy` snapshot so `auth ls` can label the numbers as
 * "as of", not live.
 */
export interface StoredQuota {
  capturedAt: string;
  fiveHour: QuotaUsageBucket | null;
  sevenDay: QuotaUsageBucket | null;
  sevenDaySonnet: QuotaUsageBucket | null;
  sevenDayOpus: QuotaUsageBucket | null;
  extraUsage: QuotaExtraUsage | null;
}

/** Raw JSON shape from the API. Extra keys are ignored. */
export interface RawUsageResponse {
  five_hour?: { utilization: number; resets_at: string } | null;
  seven_day?: { utilization: number; resets_at: string } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
  seven_day_opus?: { utilization: number; resets_at: string } | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

function parseBucket(raw: { utilization: number; resets_at: string } | null | undefined): QuotaUsageBucket | null {
  if (!raw) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at };
}

function parseExtraUsage(
  raw:
    | { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number | null }
    | null
    | undefined,
): QuotaExtraUsage | null {
  if (!raw) return null;
  return {
    isEnabled: raw.is_enabled,
    monthlyLimit: raw.monthly_limit,
    usedCredits: raw.used_credits,
    utilization: raw.utilization,
  };
}

/** Parse the raw API response into a QuotaStatus. */
export function parseUsageResponse(raw: RawUsageResponse, now: () => number = Date.now): QuotaStatus {
  return {
    fiveHour: parseBucket(raw.five_hour),
    sevenDay: parseBucket(raw.seven_day),
    sevenDaySonnet: parseBucket(raw.seven_day_sonnet),
    sevenDayOpus: parseBucket(raw.seven_day_opus),
    extraUsage: parseExtraUsage(raw.extra_usage),
    fetchedAt: now(),
  };
}

/** Project a live fetch result into the durable profile-JSON shape. */
export function toStoredQuota(status: QuotaStatus, capturedAt?: string): StoredQuota {
  return {
    capturedAt: capturedAt ?? new Date(status.fetchedAt).toISOString(),
    fiveHour: status.fiveHour,
    sevenDay: status.sevenDay,
    sevenDaySonnet: status.sevenDaySonnet,
    sevenDayOpus: status.sevenDayOpus,
    extraUsage: status.extraUsage,
  };
}

export type QuotaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchQuotaDeps {
  fetch?: QuotaFetch;
  url?: string;
  timeoutMs?: number;
  now?: () => number;
}

/** Fetch quota usage from the Anthropic OAuth usage endpoint. */
export async function fetchQuotaUsage(token: { accessToken: string }, deps?: FetchQuotaDeps): Promise<QuotaStatus> {
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const url = deps?.url ?? USAGE_URL;
  const timeoutMs = deps?.timeoutMs ?? QUOTA_REQUEST_TIMEOUT_MS;

  const resp = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
      "User-Agent": "mcp-cli/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const body = await resp.text().then(
      (text) => text,
      () => "",
    );
    const message = `Quota API returned ${resp.status}: ${body}`;
    // Status only. Sniffing the body for "rate_limit_error" would promote a 500
    // that merely quotes the string into a fleet-wide backoff.
    if (resp.status === 429) {
      throw new QuotaRateLimitError(
        message,
        parseRetryAfterHeader(resp.headers.get("retry-after"), deps?.now?.() ?? Date.now()),
      );
    }
    throw new Error(message);
  }

  const raw: RawUsageResponse = (await resp.json()) as RawUsageResponse;
  return parseUsageResponse(raw, deps?.now);
}
