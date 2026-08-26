/**
 * Claude OAuth usage endpoint — shared request/response shape plus the plain fetch.
 *
 * The daemon poller and `mcx claude auth save/load` both call this. Types live here
 * so command does not depend on @mcp-cli/daemon (the fetch takes only `{accessToken}`).
 */

import type { QuotaExtraUsage, QuotaUsageBucket } from "./ipc";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
export const QUOTA_REQUEST_TIMEOUT_MS = 5_000;

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
    throw new Error(`Quota API returned ${resp.status}: ${body}`);
  }

  const raw: RawUsageResponse = (await resp.json()) as RawUsageResponse;
  return parseUsageResponse(raw, deps?.now);
}
