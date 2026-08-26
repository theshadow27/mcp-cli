import { describe, expect, test } from "bun:test";
import { fetchQuotaUsage, parseUsageResponse, toStoredQuota } from "./quota";

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
    const result = parseUsageResponse(SAMPLE_RESPONSE, () => 1_700_000_000_000);
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
    expect(result.fetchedAt).toBe(1_700_000_000_000);
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

  test("preserves null utilization in extra_usage (zero credits used)", () => {
    const result = parseUsageResponse({
      extra_usage: {
        is_enabled: true,
        monthly_limit: 50000,
        used_credits: 0,
        utilization: null,
      },
    });
    expect(result.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 50000,
      usedCredits: 0,
      utilization: null,
    });
  });
});

describe("toStoredQuota", () => {
  test("copies buckets and formats capturedAt from fetchedAt", () => {
    const status = parseUsageResponse(SAMPLE_RESPONSE, () => Date.UTC(2026, 7, 18, 12, 0, 0));
    const stored = toStoredQuota(status);
    expect(stored.capturedAt).toBe("2026-08-18T12:00:00.000Z");
    expect(stored.fiveHour?.utilization).toBe(42);
    expect(stored.sevenDay?.resetsAt).toBe("2026-04-13T04:00:00Z");
  });

  test("honours an explicit capturedAt (deterministic save/load snapshots)", () => {
    const status = parseUsageResponse(SAMPLE_RESPONSE);
    expect(toStoredQuota(status, "2026-08-18T12:00:00.000Z").capturedAt).toBe("2026-08-18T12:00:00.000Z");
  });
});

describe("fetchQuotaUsage", () => {
  test("sends the bearer token and beta header, then parses the body", async () => {
    let urlSeen = "";
    let headers: Headers | undefined;
    const status = await fetchQuotaUsage(
      { accessToken: "sk-ant-oat01-test" },
      {
        now: () => 42,
        fetch: async (input, init) => {
          urlSeen = String(input);
          headers = new Headers(init?.headers);
          return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 });
        },
      },
    );

    expect(urlSeen).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(headers?.get("Authorization")).toBe("Bearer sk-ant-oat01-test");
    expect(headers?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(status.fiveHour?.utilization).toBe(42);
    expect(status.fetchedAt).toBe(42);
  });

  test("throws with the status and body on a non-OK response", async () => {
    try {
      await fetchQuotaUsage(
        { accessToken: "x" },
        {
          fetch: async () => new Response("auth error", { status: 401 }),
        },
      );
      throw new Error("expected fetchQuotaUsage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Quota API returned 401: auth error");
    }
  });
});
