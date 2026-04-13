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

  test("applies exponential backoff on rate-limit error", async () => {
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
        throw new Error(
          'Quota API returned 429: {"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}',
        );
      },
    });

    poller.start();
    await Bun.sleep(120);
    poller.stop();

    // With base interval of 20ms and backoff doubling (40ms, 80ms, ...), we should
    // see fewer calls than without backoff (which would be ~6 in 120ms).
    expect(calls).toBeLessThanOrEqual(4);
    expect(poller.backoffMs).toBeGreaterThanOrEqual(40);
    expect(poller.lastError).toContain("rate_limit_error");
    expect(warnings.some((w) => w.includes("rate-limited") && w.includes("backing off"))).toBe(true);
  });

  test("preserves last cached status during rate-limit", async () => {
    let callCount = 0;
    const poller = new QuotaPoller({
      intervalMs: 20,
      readToken: async () => fakeToken,
      fetchUsage: async () => {
        callCount++;
        if (callCount === 1) return parseUsageResponse(SAMPLE_RESPONSE);
        throw new Error("Quota API returned 429: rate_limit_error");
      },
    });

    poller.start();
    await Bun.sleep(120);
    poller.stop();

    // Cached status from first successful fetch is still available
    expect(poller.status?.fiveHour?.utilization).toBe(42);
    expect(poller.lastError).toContain("429");
  });

  test("resets backoff after successful fetch", async () => {
    let callCount = 0;
    const poller = new QuotaPoller({
      intervalMs: 20,
      readToken: async () => fakeToken,
      fetchUsage: async () => {
        callCount++;
        if (callCount <= 2) throw new Error("Quota API returned 429: rate_limit_error");
        return parseUsageResponse(SAMPLE_RESPONSE);
      },
    });

    poller.start();
    // Wait long enough for: fail(20ms base) → backoff(40ms) → fail → backoff(80ms) → success
    await Bun.sleep(250);
    poller.stop();

    expect(poller.lastError).toBeNull();
    expect(poller.backoffMs).toBeNull();
    expect(poller.status?.fiveHour?.utilization).toBe(42);
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
