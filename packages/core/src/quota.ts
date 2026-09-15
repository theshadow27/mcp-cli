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
  /**
   * Recent 5h/7d stamps for pace. Ring-capped; samples from a previous reset
   * window are ignored at estimate time, not rewritten here.
   */
  history?: QuotaHistorySample[];
}

/** One point on the 5h/7d series. Sonnet/opus/extra are not in the autoload path. */
export interface QuotaHistorySample {
  capturedAt: string;
  fiveHour: QuotaUsageBucket | null;
  sevenDay: QuotaUsageBucket | null;
}

/** How many stamps to keep. Daemon poller is 5m, so 48 ≈ 4h of active-profile samples. */
export const QUOTA_HISTORY_MAX = 48;
/** Two points closer than this are not a slope — likely a double stamp. */
export const QUOTA_PACE_MIN_SPAN_MS = 60_000;

/**
 * Projected burn of one usage window. `miss` is the autoload signal: utilization
 * hits 100% before `resetsAt` at the current slope. Not wired into `load --auto` yet.
 */
export interface QuotaPace {
  samples: number;
  spanMs: number;
  /** When utilization hits 100% at the current slope. Null when slope ≤ 0 (idle). */
  etaAt: string | null;
  resetsAt: string;
  miss: boolean;
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

/**
 * A usage bucket is only durable if it has a finite utilization *and* a
 * parseable reset clock. `{ utilization: 0, resets_at: null }` is a placeholder
 * the oauth usage endpoint sometimes returns for a freshly minted token — treating
 * it as a real 0% window wipes the previous snapshot.
 */
export function isCompleteQuotaBucket(
  bucket: { utilization?: unknown; resetsAt?: unknown } | null | undefined,
): bucket is QuotaUsageBucket {
  if (!bucket) return false;
  if (typeof bucket.utilization !== "number" || !Number.isFinite(bucket.utilization)) return false;
  if (typeof bucket.resetsAt !== "string" || Number.isNaN(Date.parse(bucket.resetsAt))) return false;
  return true;
}

function parseBucket(raw: { utilization: number; resets_at: string } | null | undefined): QuotaUsageBucket | null {
  if (!raw) return null;
  const bucket = { utilization: raw.utilization, resetsAt: raw.resets_at };
  return isCompleteQuotaBucket(bucket) ? bucket : null;
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

function historySampleFrom(quota: StoredQuota): QuotaHistorySample | null {
  const fiveHour = isCompleteQuotaBucket(quota.fiveHour) ? quota.fiveHour : null;
  const sevenDay = isCompleteQuotaBucket(quota.sevenDay) ? quota.sevenDay : null;
  if (!fiveHour && !sevenDay) return null;
  if (typeof quota.capturedAt !== "string" || Number.isNaN(Date.parse(quota.capturedAt))) return null;
  return { capturedAt: quota.capturedAt, fiveHour, sevenDay };
}

/**
 * Attach `incoming` as the newest history sample. Seeds from `stored`'s current
 * buckets when history is empty so a save snapshot plus the first `--fetch`
 * already make a slope. Same `capturedAt` as the last sample replaces it.
 * Incoming `history` is ignored — the series lives on the stored profile.
 */
export function appendQuotaHistory(incoming: StoredQuota, stored?: StoredQuota, max = QUOTA_HISTORY_MAX): StoredQuota {
  const sample = historySampleFrom(incoming);
  if (!sample) {
    return stored?.history ? { ...incoming, history: stored.history } : incoming;
  }
  let prev = stored?.history ?? [];
  if (prev.length === 0 && stored) {
    const seed = historySampleFrom(stored);
    if (seed && seed.capturedAt !== sample.capturedAt) prev = [seed];
  }
  const last = prev[prev.length - 1];
  const next = last && last.capturedAt === sample.capturedAt ? [...prev.slice(0, -1), sample] : [...prev, sample];
  return { ...incoming, history: next.slice(-max) };
}

type PaceBucket = "fiveHour" | "sevenDay";

/**
 * OLS slope of utilization vs time for one window. Null until two samples in the
 * *current* reset window span at least QUOTA_PACE_MIN_SPAN_MS.
 */
export function estimateQuotaPace(
  quota: StoredQuota | null | undefined,
  bucket: PaceBucket,
  now: Date = new Date(),
): QuotaPace | null {
  const current = quota?.[bucket];
  if (!isCompleteQuotaBucket(current)) return null;
  if (Date.parse(current.resetsAt) <= now.getTime()) return null;

  const points: Array<{ t: number; u: number }> = [];
  for (const row of quota?.history ?? []) {
    const b = row[bucket];
    if (!isCompleteQuotaBucket(b) || b.resetsAt !== current.resetsAt) continue;
    const t = Date.parse(row.capturedAt);
    if (Number.isNaN(t)) continue;
    points.push({ t, u: b.utilization });
  }
  if (points.length < 2) return null;
  const spanMs = points[points.length - 1].t - points[0].t;
  if (spanMs < QUOTA_PACE_MIN_SPAN_MS) return null;

  const n = points.length;
  let meanT = 0;
  let meanU = 0;
  for (const p of points) {
    meanT += p.t;
    meanU += p.u;
  }
  meanT /= n;
  meanU /= n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    num += dt * (p.u - meanU);
    den += dt * dt;
  }
  const slope = den === 0 ? 0 : num / den;
  const last = points[points.length - 1];
  const remaining = 100 - last.u;
  let etaAt: string | null = null;
  if (remaining <= 0) {
    etaAt = new Date(last.t).toISOString();
  } else if (slope > 0) {
    etaAt = new Date(last.t + remaining / slope).toISOString();
  }
  const resetMs = Date.parse(current.resetsAt);
  const miss = etaAt !== null && Date.parse(etaAt) < resetMs;
  return { samples: n, spanMs, etaAt, resetsAt: current.resetsAt, miss };
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
