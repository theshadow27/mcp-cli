import { describe, expect, test } from "bun:test";
import {
  QUOTA_HISTORY_MAX,
  QuotaRateLimitError,
  appendQuotaHistory,
  estimateQuotaPace,
  fetchQuotaUsage,
  isQuotaRateLimitError,
  parseRetryAfterHeader,
  parseUsageResponse,
  toStoredQuota,
} from "./quota";

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

  test("drops a bucket with no parseable reset clock (fresh-token placeholder)", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 0, resets_at: null as unknown as string },
      seven_day: { utilization: 0, resets_at: null as unknown as string },
    });
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBeNull();
  });

  test("keeps a real 0% window that has a reset clock", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 0, resets_at: "2026-09-02T07:00:00Z" },
    });
    expect(result.fiveHour).toEqual({ utilization: 0, resetsAt: "2026-09-02T07:00:00Z" });
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

const RESET_5H = "2026-08-18T20:00:00.000Z";
const RESET_7D = "2026-08-25T04:00:00.000Z";

function snap(capturedAt: string, five: number, seven: number) {
  return {
    capturedAt,
    fiveHour: { utilization: five, resetsAt: RESET_5H },
    sevenDay: { utilization: seven, resetsAt: RESET_7D },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
  };
}

describe("appendQuotaHistory", () => {
  test("starts a series from the incoming snapshot", () => {
    const first = snap("2026-08-18T12:00:00.000Z", 10, 8);
    expect(appendQuotaHistory(first).history).toEqual([
      { capturedAt: first.capturedAt, fiveHour: first.fiveHour, sevenDay: first.sevenDay },
    ]);
  });

  test("seeds from the stored current buckets so save + first fetch make two points", () => {
    const saved = snap("2026-08-18T12:00:00.000Z", 10, 8);
    const fetched = snap("2026-08-18T12:10:00.000Z", 20, 9);
    const out = appendQuotaHistory(fetched, saved);
    expect(out.history).toHaveLength(2);
    expect(out.history?.[0]?.fiveHour?.utilization).toBe(10);
    expect(out.history?.[1]?.fiveHour?.utilization).toBe(20);
  });

  test("replaces the last sample when capturedAt matches", () => {
    const first = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    const retry = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 11, 8), first);
    expect(retry.history).toHaveLength(1);
    expect(retry.history?.[0]?.fiveHour?.utilization).toBe(11);
  });

  test("caps the ring", () => {
    let stored = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 0, 0));
    for (let i = 1; i <= QUOTA_HISTORY_MAX + 5; i++) {
      const t = new Date(Date.UTC(2026, 7, 18, 12, i)).toISOString();
      stored = appendQuotaHistory(snap(t, i, 0), stored);
    }
    expect(stored.history).toHaveLength(QUOTA_HISTORY_MAX);
    expect(stored.history?.[0]?.fiveHour?.utilization).toBe(6);
  });

  test("keeps previous history when the incoming snapshot has no complete bucket", () => {
    const first = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    const empty = {
      capturedAt: "2026-08-18T12:10:00.000Z",
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
    };
    expect(appendQuotaHistory(empty, first).history).toEqual(first.history);
  });
});

describe("estimateQuotaPace", () => {
  const now = new Date("2026-08-18T12:30:00.000Z");

  test("null with fewer than two samples in the current window", () => {
    const q = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    expect(estimateQuotaPace(q, "fiveHour", now)).toBeNull();
  });

  test("miss when the slope hits 100% before reset", () => {
    // 10% at t0, 40% 10 minutes later → 6%/min → 10 min to 100%, reset is ~7.5h away.
    const a = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    const b = appendQuotaHistory(snap("2026-08-18T12:10:00.000Z", 40, 8), a);
    const pace = estimateQuotaPace(b, "fiveHour", now);
    expect(pace?.miss).toBe(true);
    expect(pace?.samples).toBe(2);
    expect(pace?.etaAt).toBe("2026-08-18T12:30:00.000Z");
  });

  test("ok (no eta) when utilization is flat", () => {
    const a = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 40, 8));
    const b = appendQuotaHistory(snap("2026-08-18T12:10:00.000Z", 40, 8), a);
    const pace = estimateQuotaPace(b, "fiveHour", now);
    expect(pace).toMatchObject({ miss: false, etaAt: null, samples: 2 });
  });

  test("ok when eta is after the reset", () => {
    // 1% in 10 minutes → 0.1%/min → 990 min to 100%, reset in ~7.5h.
    const a = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    const b = appendQuotaHistory(snap("2026-08-18T12:10:00.000Z", 11, 8), a);
    const pace = estimateQuotaPace(b, "fiveHour", now);
    expect(pace?.miss).toBe(false);
    expect(pace?.etaAt).not.toBeNull();
  });

  test("ignores samples from a previous 5h window", () => {
    const oldWindow = {
      ...snap("2026-08-18T06:00:00.000Z", 90, 8),
      fiveHour: { utilization: 90, resetsAt: "2026-08-18T07:00:00.000Z" },
    };
    const a = appendQuotaHistory(oldWindow);
    const b = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8), a);
    expect(estimateQuotaPace(b, "fiveHour", now)).toBeNull();
  });

  test("null once the reset has already passed", () => {
    const a = appendQuotaHistory(snap("2026-08-18T12:00:00.000Z", 10, 8));
    const b = appendQuotaHistory(snap("2026-08-18T12:10:00.000Z", 40, 8), a);
    expect(estimateQuotaPace(b, "fiveHour", new Date("2026-08-18T21:00:00.000Z"))).toBeNull();
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
      expect(err).not.toBeInstanceOf(QuotaRateLimitError);
      expect((err as Error).message).toBe("Quota API returned 401: auth error");
    }
  });

  test("throws QuotaRateLimitError on 429 and honours Retry-After seconds", async () => {
    try {
      await fetchQuotaUsage(
        { accessToken: "x" },
        {
          now: () => 0,
          fetch: async () => new Response("rate_limit_error", { status: 429, headers: { "Retry-After": "7" } }),
        },
      );
      throw new Error("expected fetchQuotaUsage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaRateLimitError);
      expect((err as QuotaRateLimitError).retryAfterMs).toBe(7_000);
      expect((err as Error).message).toContain("429");
    }
  });
});

describe("parseRetryAfterHeader", () => {
  test("parses delta-seconds and caps the wait", () => {
    expect(parseRetryAfterHeader("2")).toBe(2_000);
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("9999")).toBe(60_000);
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader("nope")).toBeNull();
  });

  test("parses HTTP-date relative to now", () => {
    expect(parseRetryAfterHeader("Wed, 21 Oct 2015 07:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(
      5_000,
    );
  });
});

describe("isQuotaRateLimitError", () => {
  test("is true only for the typed error", () => {
    expect(isQuotaRateLimitError(new QuotaRateLimitError("Quota API returned 429: slow down"))).toBe(true);
    expect(isQuotaRateLimitError(new Error("boom"))).toBe(false);
    expect(isQuotaRateLimitError("boom")).toBe(false);
  });

  test("does not promote a non-429 whose body merely contains the words", () => {
    // Both of these once classified as rate limits, which silently zeroed
    // `ls --fetch-all` for the whole fleet after three pointless backoff sleeps.
    expect(isQuotaRateLimitError(new Error('Quota API returned 500: {"request_id":"req_011CS429qT"}'))).toBe(false);
    expect(
      isQuotaRateLimitError(new Error('Quota API returned 400: {"message":"your rate limit tier is not eligible"}')),
    ).toBe(false);
    expect(isQuotaRateLimitError(new Error("Quota API returned 503: rate_limit_error mentioned in prose"))).toBe(false);
  });

  test("a 500 quoting rate_limit_error is a plain Error, not a rate limit", async () => {
    const err = await fetchQuotaUsage(
      { accessToken: "x" },
      { fetch: async () => new Response('{"type":"rate_limit_error"}', { status: 500 }) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(QuotaRateLimitError);
  });
});

describe("parseRetryAfterHeader rejects garbage", () => {
  test("a negative delta means no Retry-After, not zero backoff", () => {
    // Number("-5") once fell through to Date.parse("-5") (year -5), which parses,
    // and yielded 0 — three rapid retries with no wait at all.
    expect(parseRetryAfterHeader("-5")).toBeNull();
  });

  test("only decimal delta-seconds are accepted", () => {
    expect(parseRetryAfterHeader("0x10")).toBeNull();
    expect(parseRetryAfterHeader("1e3")).toBeNull();
    expect(parseRetryAfterHeader("Infinity")).toBeNull();
    expect(parseRetryAfterHeader("  12  ")).toBe(12_000);
  });

  test("an HTTP-date already in the past means no Retry-After", () => {
    expect(
      parseRetryAfterHeader("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:28:05 GMT")),
    ).toBeNull();
  });

  test("an HTTP-date further out than the cap is capped", () => {
    expect(parseRetryAfterHeader("Wed, 21 Oct 2015 08:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:05 GMT"))).toBe(
      60_000,
    );
  });
});
