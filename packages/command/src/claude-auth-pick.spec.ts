import { describe, expect, test } from "bun:test";
import type { QuotaUsageBucket } from "@mcp-cli/core";
import { pickRecommended, planSize, windowRemaining } from "./claude-auth-pick";
import type { ProfileSummary } from "./claude-auth-store";

const NOW = new Date("2026-08-30T02:33:00.000Z");

function profile(partial: Partial<ProfileSummary> & Pick<ProfileSummary, "name">): ProfileSummary {
  return {
    kind: "oauth",
    active: false,
    account: `${partial.name}@example.com`,
    organization: null,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    expiresAt: "2026-08-30T10:00:00.000Z",
    expired: false,
    hasRefreshToken: false,
    apiKeyEnvVar: null,
    allowRemoteControl: true,
    hasCredentials: true,
    updatedAt: NOW.toISOString(),
    quota: {
      capturedAt: NOW.toISOString(),
      fiveHour: { utilization: 10, resetsAt: "2026-08-30T07:00:00.000Z" },
      sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
    },
    ...partial,
  };
}

describe("windowRemaining", () => {
  test("treats utilization as percent used", () => {
    expect(windowRemaining({ utilization: 92, resetsAt: "2026-08-30T07:00:00.000Z" }, NOW)).toBe(8);
  });

  test("a reset already in the past makes the percent unknown", () => {
    expect(windowRemaining({ utilization: 10, resetsAt: "2026-08-30T02:00:00.000Z" }, NOW)).toBeNull();
  });
});

describe("planSize", () => {
  test("parses the multiplier out of rateLimitTier", () => {
    expect(planSize(profile({ name: "a", rateLimitTier: "default_claude_max_20x" }))).toBe(20);
    expect(planSize(profile({ name: "a", rateLimitTier: "default_claude_max_5x" }))).toBe(5);
    expect(planSize(profile({ name: "a", rateLimitTier: "claude_max_6.5x" }))).toBe(6.5);
    expect(planSize(profile({ name: "a", rateLimitTier: null, subscriptionType: "pro" }))).toBe(1);
    expect(planSize(profile({ name: "a", rateLimitTier: null, subscriptionType: "max" }))).toBeNull();
  });
});

describe("pickRecommended", () => {
  test("stays on a healthy current even if a smaller plan is idle", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "big",
          active: true,
          rateLimitTier: "default_claude_max_20x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 40, resetsAt: "2026-08-30T07:00:00.000Z" },
            sevenDay: { utilization: 30, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "cheap",
          rateLimitTier: "claude_max_6.5x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 5, resetsAt: "2026-08-30T07:00:00.000Z" },
            sevenDay: { utilization: 5, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick).toMatchObject({ profile: "big", action: "stay" });
  });

  test("leaves current when 5h remaining is under epsilon and picks the smallest eligible", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "dying",
          active: true,
          rateLimitTier: "claude_max_6.5x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 95, resetsAt: "2026-08-30T07:00:00.000Z" },
            sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "ten",
          rateLimitTier: "default_claude_max_10x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 20, resetsAt: "2026-08-30T08:00:00.000Z" },
            sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "twenty",
          rateLimitTier: "default_claude_max_20x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 10, resetsAt: "2026-08-30T08:00:00.000Z" },
            sevenDay: { utilization: 10, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick).toMatchObject({ profile: "ten", action: "load" });
  });

  test("harvests a dying unused 5h window even when current is healthy", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "sticky",
          active: true,
          rateLimitTier: "default_claude_max_20x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 4, resetsAt: "2026-08-30T07:00:00.000Z" },
            sevenDay: { utilization: 11, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "gbg",
          rateLimitTier: "default_claude_max_20x",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 0, resetsAt: "2026-08-30T02:50:00.000Z" },
            sevenDay: { utilization: 62, resetsAt: "2026-09-04T13:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick.action).toBe("load");
    expect(pick.profile).toBe("gbg");
    expect(pick.reason).toContain("harvest");
  });

  test("skips expired hop targets and waits when nothing eligible remains", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "ozone",
          active: true,
          expired: true,
          expiresAt: "2026-08-29T22:46:00.000Z",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 66, resetsAt: "2026-08-30T08:10:00.000Z" },
            sevenDay: { utilization: 18, resetsAt: "2026-09-04T05:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "dead",
          expired: true,
          expiresAt: "2026-08-27T03:11:00.000Z",
          quota: {
            capturedAt: "2026-08-26T19:38:00.000Z",
            fiveHour: { utilization: 100, resetsAt: "2026-08-26T20:00:00.000Z" },
            sevenDay: { utilization: 1, resetsAt: "2026-08-30T03:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick).toMatchObject({ profile: null, action: "wait" });
    expect(pick.reason).toContain("every stored token is expired");
  });

  test("does not hop to a profile whose 5h snapshot is already past reset", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "dying",
          active: true,
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 96, resetsAt: "2026-08-30T07:00:00.000Z" },
            sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "stale",
          quota: {
            capturedAt: "2026-08-29T18:19:00.000Z",
            fiveHour: { utilization: 65, resetsAt: "2026-08-29T21:09:00.000Z" },
            sevenDay: { utilization: 11, resetsAt: "2026-08-30T12:59:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick.action).toBe("wait");
  });

  test("when sizes tie, prefers the soonest 5h reset", () => {
    const pick = pickRecommended(
      [
        profile({
          name: "later",
          active: true,
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 96, resetsAt: "2026-08-30T04:00:00.000Z" },
            sevenDay: { utilization: 10, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "sooner",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 20, resetsAt: "2026-08-30T03:30:00.000Z" },
            sevenDay: { utilization: 40, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
        profile({
          name: "later-ok",
          quota: {
            capturedAt: NOW.toISOString(),
            fiveHour: { utilization: 20, resetsAt: "2026-08-30T08:00:00.000Z" },
            sevenDay: { utilization: 5, resetsAt: "2026-09-04T00:00:00.000Z" },
            sevenDaySonnet: null,
            sevenDayOpus: null,
            extraUsage: null,
          },
        }),
      ],
      NOW,
    );
    expect(pick.profile).toBe("sooner");
    expect(pick.action).toBe("load");
  });
});

/**
 * Guard coverage (#3429). Every test below is mutation-verified: deleting or inverting
 * the single guard named in its title makes it fail. Fixtures are built so exactly one
 * guard decides the verdict — no other term in the picker can carry the assertion.
 */
describe("pickRecommended guards", () => {
  /** A profile with fresh, roomy numbers. `at` is minutes from NOW for the 5h reset. */
  function healthy(name: string, partial: Partial<ProfileSummary> = {}, resetMinutes = 267): ProfileSummary {
    return profile({
      name,
      quota: {
        capturedAt: NOW.toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(NOW.getTime() + resetMinutes * 60_000).toISOString() },
        sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
      },
      ...partial,
    });
  }

  /** An active profile at `remaining`% of its 5h window, forcing a departure below 8%. */
  function dying(remaining: number): ProfileSummary {
    return healthy("dying", {
      active: true,
      quota: {
        capturedAt: NOW.toISOString(),
        fiveHour: { utilization: 100 - remaining, resetsAt: "2026-08-30T07:00:00.000Z" },
        sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
      },
    });
  }

  test("windowRemaining: a null utilization is unknown, not 100", () => {
    const bucket = { utilization: null, resetsAt: "2026-08-30T07:00:00.000Z" } as unknown as QuotaUsageBucket;
    expect(windowRemaining(bucket, NOW)).toBeNull();
  });

  test("isEligible: a profile with no stored credentials is never recommended", () => {
    const pick = pickRecommended([dying(1), healthy("ghost", { hasCredentials: false })], NOW);
    expect(pick.action).toBe("wait");
    expect(pick.profile).toBeNull();
  });

  test("oauthUsable: an expired token is disqualifying without a refresh token", () => {
    const pick = pickRecommended(
      [dying(1), healthy("dead", { expired: true, expiresAt: "2026-08-29T22:46:00.000Z", hasRefreshToken: false })],
      NOW,
    );
    expect(pick.action).toBe("wait");
  });

  test("oauthUsable: `expired` is believed even when the expiry timestamp is unknown", () => {
    // The lead check cannot carry this one: with no `expiresAt` it returns usable.
    const pick = pickRecommended([dying(1), healthy("dead", { expired: true, expiresAt: null })], NOW);
    expect(pick.action).toBe("wait");
  });

  test("oauthUsable: an expired token is fine WITH a refresh token — Claude re-mints it", () => {
    const pick = pickRecommended(
      [
        dying(1),
        healthy("stale-token", { expired: true, expiresAt: "2026-08-29T22:46:00.000Z", hasRefreshToken: true }),
      ],
      NOW,
    );
    expect(pick).toMatchObject({ profile: "stale-token", action: "load" });
  });

  test("oauthUsable: an unparsable expiry is treated as usable", () => {
    const pick = pickRecommended([dying(1), healthy("weird", { expiresAt: "not-a-date", expired: false })], NOW);
    expect(pick).toMatchObject({ profile: "weird", action: "load" });
  });

  test("oauthUsable: the 30-minute lead is exact — 30m out is usable, 29m59s is not", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    const inThirty = pickRecommended([dying(1), healthy("lead", { expiresAt: at(30 * 60_000) })], NOW);
    expect(inThirty).toMatchObject({ profile: "lead", action: "load" });

    const justUnder = pickRecommended([dying(1), healthy("lead", { expiresAt: at(30 * 60_000 - 1_000) })], NOW);
    expect(justUnder.action).toBe("wait");
  });

  test("isEligible: the 8% 5h floor is exact — 8% stays, 7.9% leaves", () => {
    expect(pickRecommended([dying(8), healthy("other")], NOW)).toMatchObject({ profile: "dying", action: "stay" });
    expect(pickRecommended([dying(7.9), healthy("other")], NOW)).toMatchObject({ profile: "other", action: "load" });
  });

  test("isEligible: the 12% 7d floor is exact — 12% is eligible, 11.9% is not", () => {
    const withSeven = (name: string, remaining: number) =>
      healthy(name, {
        quota: {
          capturedAt: NOW.toISOString(),
          fiveHour: { utilization: 10, resetsAt: "2026-08-30T07:00:00.000Z" },
          sevenDay: { utilization: 100 - remaining, resetsAt: "2026-09-04T00:00:00.000Z" },
          sevenDaySonnet: null,
          sevenDayOpus: null,
          extraUsage: null,
        },
      });
    expect(pickRecommended([dying(1), withSeven("target", 12)], NOW)).toMatchObject({
      profile: "target",
      action: "load",
    });
    expect(pickRecommended([dying(1), withSeven("target", 11.9)], NOW).action).toBe("wait");
  });

  test("mustLeave: a 7d window under 12% forces a departure even with 5h to spare", () => {
    const current = healthy("current", {
      active: true,
      quota: {
        capturedAt: NOW.toISOString(),
        fiveHour: { utilization: 1, resetsAt: "2026-08-30T07:00:00.000Z" },
        sevenDay: { utilization: 89, resetsAt: "2026-09-04T00:00:00.000Z" },
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
      },
    });
    const pick = pickRecommended([current, healthy("other")], NOW);
    expect(pick).toMatchObject({ profile: "other", action: "load" });
    expect(pick.reason).toContain("7d remaining");
  });

  test("mustLeave: unknown is not healthy — a never-fetched current is left for a fresh one", () => {
    const pick = pickRecommended([healthy("blind", { active: true, quota: null }), healthy("fresh")], NOW);
    expect(pick).toMatchObject({ profile: "fresh", action: "load" });
    expect(pick.reason).toContain("quota unknown");
  });

  test("mustLeave: an exhausted current whose snapshot just went stale is still left", () => {
    const stale = healthy("stale", {
      active: true,
      quota: {
        capturedAt: "2026-08-30T02:28:00.000Z",
        fiveHour: { utilization: 100, resetsAt: "2026-08-30T02:30:00.000Z" },
        sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
      },
    });
    expect(pickRecommended([stale, healthy("fresh")], NOW)).toMatchObject({ profile: "fresh", action: "load" });
  });

  test("isHarvest: the 30% floor is exact — 30% left does not preempt, 30.1% does", () => {
    const at30 = healthy("gbg", { quota: harvestQuota(30, 20) });
    expect(pickRecommended([healthy("sticky", { active: true }), at30], NOW).action).toBe("stay");
    const at31 = healthy("gbg", { quota: harvestQuota(30.1, 20) });
    expect(pickRecommended([healthy("sticky", { active: true }), at31], NOW)).toMatchObject({
      profile: "gbg",
      action: "load",
    });
  });

  test("isHarvest: the 45-minute window is exact — 45m out does not preempt, 44m59s does", () => {
    const at45 = healthy("gbg", { quota: harvestQuota(90, 45) });
    expect(pickRecommended([healthy("sticky", { active: true }), at45], NOW).action).toBe("stay");
    const under = healthy("gbg", { quota: harvestQuota(90, 44.9833) });
    expect(pickRecommended([healthy("sticky", { active: true }), under], NOW)).toMatchObject({
      profile: "gbg",
      action: "load",
    });
  });

  test("isHarvest: an ineligible profile is never harvested", () => {
    const burned = healthy("burned", {
      quota: {
        ...harvestQuota(90, 20),
        sevenDay: { utilization: 95, resetsAt: "2026-09-04T00:00:00.000Z" },
      },
    });
    expect(pickRecommended([healthy("sticky", { active: true }), burned], NOW).action).toBe("stay");
  });

  test("isHarvest: CURRENT never harvests itself", () => {
    const self = healthy("sticky", { active: true, quota: harvestQuota(90, 20) });
    expect(pickRecommended([self, healthy("other")], NOW)).toMatchObject({ profile: "sticky", action: "stay" });
  });

  test("compareEligible: with size and reset tied, more 7d remaining wins", () => {
    const tied = (name: string, sevenUsed: number) =>
      healthy(name, {
        quota: {
          capturedAt: NOW.toISOString(),
          fiveHour: { utilization: 10, resetsAt: "2026-08-30T08:00:00.000Z" },
          sevenDay: { utilization: sevenUsed, resetsAt: "2026-09-04T00:00:00.000Z" },
          sevenDaySonnet: null,
          sevenDayOpus: null,
          extraUsage: null,
        },
      });
    // Thin first, so a dropped tiebreak would leave the stable sort on "thin".
    expect(pickRecommended([dying(1), tied("thin", 80), tied("roomy", 5)], NOW)).toMatchObject({
      profile: "roomy",
      action: "load",
    });
  });

  test("the pool is oauth-only: an api-key store has no recommendation at all", () => {
    const key = profile({ name: "key", kind: "api-key", active: true, apiKeyEnvVar: "ANTHROPIC_API_KEY" });
    expect(pickRecommended([key], NOW)).toEqual({ profile: null, action: "wait", reason: "no oauth profiles" });
  });

  test("a wait verdict names nobody and says which of the two dead ends it is", () => {
    const noCreds = pickRecommended([healthy("a", { active: true, hasCredentials: false, quota: null })], NOW);
    expect(noCreds).toMatchObject({ profile: null, action: "wait" });
    expect(noCreds.reason).toContain("no profile has stored credentials");

    const exhausted = pickRecommended([dying(1)], NOW);
    expect(exhausted).toMatchObject({ profile: null, action: "wait" });
    expect(exhausted.reason).toContain("wait for a 5h reset");
  });

  /** 5h bucket with `remaining`% left, resetting `inMinutes` from NOW. */
  function harvestQuota(remaining: number, inMinutes: number) {
    return {
      capturedAt: NOW.toISOString(),
      fiveHour: {
        utilization: 100 - remaining,
        resetsAt: new Date(NOW.getTime() + inMinutes * 60_000).toISOString(),
      },
      sevenDay: { utilization: 20, resetsAt: "2026-09-04T00:00:00.000Z" },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
    };
  }
});
