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
export const DEFAULT_OAUTH_LEAD_MS = 30 * 60 * 1000;
export const DEFAULT_HARVEST_REMAINING = 30;
export const DEFAULT_HARVEST_WINDOW_MS = 45 * 60 * 1000;

export interface AuthPickOptions {
  epsilon5: number;
  epsilon7: number;
  oauthLeadMs: number;
  harvestRemaining: number;
  harvestWindowMs: number;
}

export const DEFAULT_AUTH_PICK: AuthPickOptions = {
  epsilon5: DEFAULT_EPSILON5,
  epsilon7: DEFAULT_EPSILON7,
  oauthLeadMs: DEFAULT_OAUTH_LEAD_MS,
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

function oauthUsable(profile: ProfileSummary, now: Date, leadMs: number): boolean {
  if (profile.kind !== "oauth") return false;
  if (profile.expired === true) return false;
  if (!profile.expiresAt) return true;
  const expires = Date.parse(profile.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires - now.getTime() >= leadMs;
}

function isEligible(profile: ProfileSummary, now: Date, opts: AuthPickOptions): boolean {
  if (!oauthUsable(profile, now, opts.oauthLeadMs)) return false;
  const five = windowRemaining(profile.quota?.fiveHour, now);
  const seven = windowRemaining(profile.quota?.sevenDay, now);
  if (five == null || seven == null) return false;
  return five >= opts.epsilon5 && seven >= opts.epsilon7;
}

function mustLeave(current: ProfileSummary, now: Date, opts: AuthPickOptions): boolean {
  if (!oauthUsable(current, now, opts.oauthLeadMs)) return true;
  const five = windowRemaining(current.quota?.fiveHour, now);
  const seven = windowRemaining(current.quota?.sevenDay, now);
  if (five != null && five < opts.epsilon5) return true;
  if (seven != null && seven < opts.epsilon7) return true;
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
  const inMs = resetAtMs(profile) - now.getTime();
  return inMs > 0 && inMs < opts.harvestWindowMs;
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

  if (eligible.length === 0) {
    return {
      profile: current?.name ?? null,
      action: "wait",
      reason: "no eligible profile; wait for a 5h reset",
    };
  }

  const winner = [...eligible].sort((a, b) => compareEligible(a, b, now))[0];
  if (current && winner.name === current.name) {
    return { profile: winner.name, action: "stay", reason: "current is the best eligible" };
  }
  return {
    profile: winner.name,
    action: "load",
    reason: current
      ? `leave ${current.name}: ${leaveWhy(current, now, opts)}; pick ${winner.name}`
      : `pick ${winner.name}`,
  };
}

function leaveWhy(current: ProfileSummary, now: Date, opts: AuthPickOptions): string {
  if (current.expired === true) return "oauth expired";
  if (current.expiresAt) {
    const expires = Date.parse(current.expiresAt);
    if (!Number.isNaN(expires) && expires - now.getTime() < opts.oauthLeadMs) return "oauth expiring";
  }
  const five = windowRemaining(current.quota?.fiveHour, now);
  if (five != null && five < opts.epsilon5) return `5h remaining ${five.toFixed(1)}%`;
  const seven = windowRemaining(current.quota?.sevenDay, now);
  if (seven != null && seven < opts.epsilon7) return `7d remaining ${seven.toFixed(1)}%`;
  return "must leave";
}

function formatReset(profile: ProfileSummary): string {
  const stamp = profile.quota?.fiveHour?.resetsAt;
  if (!stamp) return "soon";
  return stamp.replace("T", " ").slice(0, 16);
}
