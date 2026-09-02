/**
 * Sticky quota picker over `mcx claude auth ls` snapshots.
 *
 * Utilization in the usage API is percent *used*; remaining is 100 - used.
 * A window whose resetsAt is already in the past is unknown, not 0 — hop
 * targets need live-enough numbers. Ranking only runs when CURRENT must
 * leave, plus one harvest preemption for a dying 5h window.
 */

import type { QuotaUsageBucket } from "@mcp-cli/core";
import type { ProfileSummary } from "./claude-auth-store";

export const DEFAULT_EPSILON5 = 8;
export const DEFAULT_EPSILON7 = 12;
export const DEFAULT_HARVEST_REMAINING = 30;
export const DEFAULT_HARVEST_WINDOW_MS = 45 * 60 * 1000;

export interface AuthPickOptions {
  epsilon5: number;
  epsilon7: number;
  harvestRemaining: number;
  harvestWindowMs: number;
}

export const DEFAULT_AUTH_PICK: AuthPickOptions = {
  epsilon5: DEFAULT_EPSILON5,
  epsilon7: DEFAULT_EPSILON7,
  harvestRemaining: DEFAULT_HARVEST_REMAINING,
  harvestWindowMs: DEFAULT_HARVEST_WINDOW_MS,
};

export type AuthPickAction = "stay" | "load" | "wait";

export interface AuthPick {
  /** Profile to run on. Null only when there is no oauth profile at all. */
  profile: string | null;
  action: AuthPickAction;
  reason: string;
}

/** Percent remaining in a usage window, or null when the snapshot cannot be trusted. */
export function windowRemaining(bucket: QuotaUsageBucket | null | undefined, now: Date): number | null {
  if (!bucket || bucket.utilization == null) return null;
  if (bucket.resetsAt) {
    const reset = Date.parse(bucket.resetsAt);
    if (!Number.isNaN(reset) && reset <= now.getTime()) return null;
  }
  return 100 - bucket.utilization;
}

/**
 * Plan-size rank from `rateLimitTier` (`default_claude_max_20x` → 20).
 * Smaller tanks sort first. Unknown is last so unlabeled accounts are not
 * preferred as "cheapest".
 */
export function planSize(summary: ProfileSummary): number | null {
  const tier = summary.rateLimitTier;
  if (tier) {
    const match = /(\d+(?:\.\d+)?)x/i.exec(tier);
    if (match) return Number(match[1]);
  }
  if (summary.subscriptionType === "pro") return 1;
  return null;
}

/**
 * Can this profile be switched to?
 *
 * Access-token expiry is not a hop gate: `load` writes the stored blob (refresh
 * token included) into `.credentials.json` and Claude Code does the oauth
 * exchange. `expired` on the ls row is a display of the stored access token's
 * clock, not a verdict.
 */
function oauthUsable(profile: ProfileSummary): boolean {
  return profile.kind === "oauth" && profile.hasCredentials;
}

function isEligible(profile: ProfileSummary, now: Date, opts: AuthPickOptions): boolean {
  // A profile with no stored credentials cannot be loaded — `loadProfile` moves the
  // pointer and leaves `.credentials.json` untouched, so mcx would believe it runs as
  // one identity while Claude runs as another (#3425). Never recommend one.
  if (!oauthUsable(profile)) return false;
  const five = windowRemaining(profile.quota?.fiveHour, now);
  const seven = windowRemaining(profile.quota?.sevenDay, now);
  if (five == null || seven == null) return false;
  return five >= opts.epsilon5 && seven >= opts.epsilon7;
}

/**
 * Must CURRENT be left?
 *
 * `null` (never fetched, utilization absent, snapshot older than its own reset) means
 * *unknown*, and unknown is not healthy. `isEligible` has always disqualified null;
 * treating it as "fine" here was the asymmetry that let a fully exhausted account whose
 * snapshot went slightly stale read as healthy and never be left (#3427).
 */
function mustLeave(current: ProfileSummary, now: Date, opts: AuthPickOptions): boolean {
  if (!oauthUsable(current)) return true;
  const five = windowRemaining(current.quota?.fiveHour, now);
  const seven = windowRemaining(current.quota?.sevenDay, now);
  if (five == null || seven == null) return true;
  if (five < opts.epsilon5) return true;
  if (seven < opts.epsilon7) return true;
  return false;
}

function resetAtMs(profile: ProfileSummary): number {
  const stamp = profile.quota?.fiveHour?.resetsAt;
  if (!stamp) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function isHarvest(profile: ProfileSummary, now: Date, opts: AuthPickOptions): boolean {
  const five = windowRemaining(profile.quota?.fiveHour, now);
  if (five == null || five <= opts.harvestRemaining) return false;
  // No `inMs > 0` term: `windowRemaining` already returned null for a reset in the
  // past, and an absent/unparsable one makes `resetAtMs` +Infinity.
  return resetAtMs(profile) - now.getTime() < opts.harvestWindowMs;
}

function compareEligible(a: ProfileSummary, b: ProfileSummary, now: Date): number {
  const sizeA = planSize(a) ?? Number.POSITIVE_INFINITY;
  const sizeB = planSize(b) ?? Number.POSITIVE_INFINITY;
  if (sizeA !== sizeB) return sizeA - sizeB;
  const resetA = resetAtMs(a);
  const resetB = resetAtMs(b);
  if (resetA !== resetB) return resetA - resetB;
  const sevenA = windowRemaining(a.quota?.sevenDay, now) ?? Number.NEGATIVE_INFINITY;
  const sevenB = windowRemaining(b.quota?.sevenDay, now) ?? Number.NEGATIVE_INFINITY;
  return sevenB - sevenA;
}

function compareHarvest(a: ProfileSummary, b: ProfileSummary): number {
  return resetAtMs(a) - resetAtMs(b);
}

export function pickRecommended(
  profiles: readonly ProfileSummary[],
  now: Date,
  overrides?: Partial<AuthPickOptions>,
): AuthPick {
  const opts = { ...DEFAULT_AUTH_PICK, ...overrides };
  const pool = profiles.filter((p) => p.kind === "oauth");
  if (pool.length === 0) return { profile: null, action: "wait", reason: "no oauth profiles" };

  const current = pool.find((p) => p.active) ?? null;
  const eligible = pool.filter((p) => isEligible(p, now, opts));

  if (current && !mustLeave(current, now, opts)) {
    const harvest = eligible.filter((p) => isHarvest(p, now, opts)).sort(compareHarvest)[0];
    if (harvest && harvest.name !== current.name) {
      return {
        profile: harvest.name,
        action: "load",
        reason: `harvest 5h window on ${harvest.name} (resets ${formatReset(harvest)})`,
      };
    }
    return { profile: current.name, action: "stay", reason: "current is healthy" };
  }

  // `wait` names nobody: a `recommended: true` next to "wait for a 5h reset" is a
  // contract an automation reading the JSON cannot use (#3428).
  if (eligible.length === 0) return { profile: null, action: "wait", reason: waitWhy(pool, current, now) };

  const winner = [...eligible].sort((a, b) => compareEligible(a, b, now))[0];
  return {
    profile: winner.name,
    action: "load",
    reason: current
      ? `leave ${current.name}: ${leaveWhy(current, now, opts)}; pick ${winner.name}`
      : `pick ${winner.name}`,
  };
}

/**
 * Why nothing is eligible. "wait for a 5h reset" blames quota, and a responder who
 * believes it waits forever when the real cause is token bookkeeping (#3423).
 */
function waitWhy(pool: readonly ProfileSummary[], current: ProfileSummary | null, now: Date): string {
  if (pool.every((p) => !p.hasCredentials)) {
    return "no profile has stored credentials — run `mcx claude auth save <name>`";
  }
  const five = current ? windowRemaining(current.quota?.fiveHour, now) : null;
  const seven = current ? windowRemaining(current.quota?.sevenDay, now) : null;
  if (current && (five == null || seven == null)) {
    return "quota is unknown for every profile — run `mcx claude auth ls --fetch-all`";
  }
  return "no eligible profile; wait for a 5h reset";
}

function leaveWhy(current: ProfileSummary, now: Date, opts: AuthPickOptions): string {
  const five = windowRemaining(current.quota?.fiveHour, now);
  if (five != null && five < opts.epsilon5) return `5h remaining ${five.toFixed(1)}%`;
  const seven = windowRemaining(current.quota?.sevenDay, now);
  if (seven != null && seven < opts.epsilon7) return `7d remaining ${seven.toFixed(1)}%`;
  if (five == null || seven == null) return "quota unknown (stale or never fetched)";
  return "must leave";
}

function formatReset(profile: ProfileSummary): string {
  const stamp = profile.quota?.fiveHour?.resetsAt;
  if (!stamp) return "soon";
  return stamp.replace("T", " ").slice(0, 16);
}

export const AUTH_LS_SORTS = ["7d-reset", "name"] as const;
export type AuthLsSort = (typeof AUTH_LS_SORTS)[number];
export const DEFAULT_AUTH_LS_SORT: AuthLsSort = "7d-reset";

export function isAuthLsSort(value: string): value is AuthLsSort {
  return (AUTH_LS_SORTS as readonly string[]).includes(value);
}

function sevenDayResetMs(profile: ProfileSummary): number {
  const stamp = profile.quota?.sevenDay?.resetsAt;
  if (!stamp) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Default ls order: soonest 7d reset first, then least 7d remaining.
 * Missing reset/remaining sort last; name is the last tie-break.
 */
export function compareProfilesForLs(a: ProfileSummary, b: ProfileSummary, now: Date, sort: AuthLsSort): number {
  if (sort === "name") return a.name.localeCompare(b.name);
  const reset = sevenDayResetMs(a) - sevenDayResetMs(b);
  if (reset !== 0) return reset;
  const remA = windowRemaining(a.quota?.sevenDay, now);
  const remB = windowRemaining(b.quota?.sevenDay, now);
  const va = remA == null ? Number.POSITIVE_INFINITY : remA;
  const vb = remB == null ? Number.POSITIVE_INFINITY : remB;
  if (va !== vb) return va - vb;
  return a.name.localeCompare(b.name);
}

export function sortProfilesForLs(
  profiles: readonly ProfileSummary[],
  now: Date,
  sort: AuthLsSort = DEFAULT_AUTH_LS_SORT,
): ProfileSummary[] {
  return [...profiles].sort((a, b) => compareProfilesForLs(a, b, now, sort));
}
