import { describe, expect, test } from "bun:test";
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
    expect(pick).toMatchObject({ profile: "ozone", action: "wait" });
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
