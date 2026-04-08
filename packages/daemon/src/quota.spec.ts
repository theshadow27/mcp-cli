import { describe, expect, test } from "bun:test";
import type { ClaudeOAuthToken } from "./auth/keychain";
import { QuotaPoller, type QuotaStatus, parseUsageResponse } from "./quota";

const SAMPLE_RESPONSE = {
  five_hour: { utilization: 42, resets_at: "2026-04-08T20:00:01Z" },
  seven_day: { utilization: 8, resets_at: "2026-04-13T04:00:00Z" },
  seven_day_sonnet: { utilization: 6, resets_at: "2026-04-09T18:00:00Z" },
  seven_day_opus: null,
  seven_day_cowork: null,
  seven_day_oauth_apps: null,
  iguana_necktie: null,
  extra_usage: {
    is_enabled: true,
    monthly_limit: 2000,
    used_credits: 676,
    utilization: 33.8,
  },
};

describe("parseUsageResponse", () => {
  test("parses full response", () => {
    const result = parseUsageResponse(SAMPLE_RESPONSE);
    expect(result.fiveHour).toEqual({ utilization: 42, resetsAt: "2026-04-08T20:00:01Z" });
    expect(result.sevenDay).toEqual({ utilization: 8, resetsAt: "2026-04-13T04:00:00Z" });
    expect(result.sevenDaySonnet).toEqual({ utilization: 6, resetsAt: "2026-04-09T18:00:00Z" });
    expect(result.sevenDayOpus).toBeNull();
    expect(result.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 2000,
      usedCredits: 676,
      utilization: 33.8,
    });
    expect(result.fetchedAt).toBeGreaterThan(0);
  });

  test("handles empty response", () => {
    const result = parseUsageResponse({});
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBeNull();
    expect(result.sevenDaySonnet).toBeNull();
    expect(result.sevenDayOpus).toBeNull();
    expect(result.extraUsage).toBeNull();
  });

  test("handles partial response", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 10, resets_at: "2026-04-08T12:00:00Z" },
    });
    expect(result.fiveHour).toEqual({ utilization: 10, resetsAt: "2026-04-08T12:00:00Z" });
    expect(result.sevenDay).toBeNull();
  });
});

describe("QuotaPoller", () => {
  const fakeToken: ClaudeOAuthToken = {
    accessToken: "sk-ant-oat01-fake",
    expiresAt: Date.now() + 3_600_000,
  };

  test("status is null before first poll", () => {
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => null,
      fetchUsage: async () => parseUsageResponse({}),
    });
    expect(poller.status).toBeNull();
    expect(poller.lastError).toBeNull();
  });

  test("fetches and stores quota on poll", async () => {
    let fetched = false;
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => fakeToken,
      fetchUsage: async () => {
        fetched = true;
        return parseUsageResponse(SAMPLE_RESPONSE);
      },
    });

    poller.start();
    // Wait for the immediate first poll
    await Bun.sleep(50);
    poller.stop();

    expect(fetched).toBe(true);
    expect(poller.status).not.toBeNull();
    expect(poller.status?.fiveHour?.utilization).toBe(42);
    expect(poller.lastError).toBeNull();
  });

  test("skips silently when no token available", async () => {
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
    });

    poller.start();
    await Bun.sleep(50);
    poller.stop();

    expect(poller.status).toBeNull();
    expect(poller.lastError).toBeNull();
  });

  test("stores error on fetch failure", async () => {
    const warnings: string[] = [];
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        debug: () => {},
      },
      readToken: async () => fakeToken,
      fetchUsage: async () => {
        throw new Error("Quota API returned 401: auth error");
      },
    });

    poller.start();
    await Bun.sleep(50);
    poller.stop();

    expect(poller.lastError).toBe("Quota API returned 401: auth error");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Quota fetch failed");
  });

  test("logs error only once on repeated failures", async () => {
    const warnings: string[] = [];
    let calls = 0;
    const poller = new QuotaPoller({
      intervalMs: 20,
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        debug: () => {},
      },
      readToken: async () => fakeToken,
      fetchUsage: async () => {
        calls++;
        throw new Error("network error");
      },
    });

    poller.start();
    await Bun.sleep(100);
    poller.stop();

    // Multiple poll cycles but only one warning logged
    expect(calls).toBeGreaterThan(1);
    expect(warnings.length).toBe(1);
  });

  test("logs warning at 80% threshold", async () => {
    const warnings: string[] = [];
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        debug: () => {},
      },
      readToken: async () => fakeToken,
      fetchUsage: async () =>
        parseUsageResponse({
          five_hour: { utilization: 85, resets_at: "2026-04-08T20:00:00Z" },
        }),
    });

    poller.start();
    await Bun.sleep(50);
    poller.stop();

    expect(warnings.some((w) => w.includes("Quota warning") && w.includes("85%"))).toBe(true);
  });

  test("logs critical warning at 95% threshold", async () => {
    const warnings: string[] = [];
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        debug: () => {},
      },
      readToken: async () => fakeToken,
      fetchUsage: async () =>
        parseUsageResponse({
          five_hour: { utilization: 97, resets_at: "2026-04-08T20:00:00Z" },
        }),
    });

    poller.start();
    await Bun.sleep(50);
    poller.stop();

    expect(warnings.some((w) => w.includes("CRITICAL") && w.includes("97%"))).toBe(true);
  });

  test("stop is idempotent", () => {
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => null,
      fetchUsage: async () => parseUsageResponse({}),
    });
    poller.stop();
    poller.stop();
  });

  test("start is idempotent", async () => {
    let calls = 0;
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => {
        calls++;
        return null;
      },
      fetchUsage: async () => parseUsageResponse({}),
    });
    poller.start();
    poller.start(); // second start should be a no-op
    await Bun.sleep(50);
    poller.stop();
    expect(calls).toBe(1); // only one immediate poll, not two
  });
});
