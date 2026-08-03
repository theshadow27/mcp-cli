import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RATE_LIMIT_MAX_QUEUE,
  RateLimitQueueFullError,
  RateLimiter,
  parseRateLimit,
  rateLimitEnvVar,
  rateLimitSource,
  resolveRateLimit,
} from "./rate-limit";

/**
 * Virtual clock so throttling tests assert the CONDITION (ordering, wait
 * amounts) instead of waiting on wall time.
 */
function fakeClock(start = 1_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
    sleeps,
  };
}

describe("parseRateLimit", () => {
  test("parses the documented unit forms", () => {
    expect(parseRateLimit("3/s")).toEqual({ count: 3, windowMs: 1_000, source: "3/s" });
    expect(parseRateLimit("30/m")).toEqual({ count: 30, windowMs: 60_000, source: "30/m" });
    expect(parseRateLimit("1000/h")).toEqual({ count: 1000, windowMs: 3_600_000, source: "1000/h" });
  });

  test("supports an explicit window multiplier", () => {
    expect(parseRateLimit("2/500ms").windowMs).toBe(500);
    expect(parseRateLimit("10/5m").windowMs).toBe(300_000);
  });

  test("tolerates surrounding and internal whitespace", () => {
    expect(parseRateLimit("  3 / s ")).toEqual({ count: 3, windowMs: 1_000, source: "3 / s" });
  });

  test("distinguishes minutes from milliseconds", () => {
    expect(parseRateLimit("1/m").windowMs).toBe(60_000);
    expect(parseRateLimit("1/ms").windowMs).toBe(1);
  });

  for (const bad of ["", "abc", "3", "3/", "/s", "3/x", "0/s", "3/0s", "-1/s", "3/s extra", "3.5/s"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseRateLimit(bad)).toThrow(/Invalid rate limit/);
    });
  }

  test("error message names the expected format", () => {
    expect(() => parseRateLimit("nope")).toThrow(/"<count>\/<window>"/);
  });
});

describe("rateLimitEnvVar", () => {
  test("upper-cases and sanitizes non-alphanumerics", () => {
    expect(rateLimitEnvVar("atlassian")).toBe("MCX_RATE_LIMIT_ATLASSIAN");
    expect(rateLimitEnvVar("my-server.v2")).toBe("MCX_RATE_LIMIT_MY_SERVER_V2");
    expect(rateLimitEnvVar("_aliases")).toBe("MCX_RATE_LIMIT__ALIASES");
  });
});

describe("resolveRateLimit", () => {
  test("returns null when neither config nor env sets a limit", () => {
    expect(resolveRateLimit("atlassian", undefined, {})).toBeNull();
    expect(rateLimitSource("atlassian", undefined, {})).toBe("");
  });

  test("config value wins over env", () => {
    const env = { MCX_RATE_LIMIT_ATLASSIAN: "10/s" };
    expect(resolveRateLimit("atlassian", "3/s", env)?.count).toBe(3);
  });

  test("falls back to env when config is unset or blank", () => {
    const env = { MCX_RATE_LIMIT_ATLASSIAN: "10/s" };
    expect(resolveRateLimit("atlassian", undefined, env)?.count).toBe(10);
    expect(resolveRateLimit("atlassian", "   ", env)?.count).toBe(10);
  });

  test("propagates parse errors from an env value", () => {
    expect(() => resolveRateLimit("atlassian", undefined, { MCX_RATE_LIMIT_ATLASSIAN: "fast" })).toThrow(
      /Invalid rate limit/,
    );
  });
});

describe("RateLimiter", () => {
  test("admits calls within the window without waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("3/s"), clock);

    expect(await limiter.acquire()).toBe(0);
    expect(await limiter.acquire()).toBe(0);
    expect(await limiter.acquire()).toBe(0);

    expect(clock.sleeps).toEqual([]);
    expect(limiter.utilization()).toBe(1);
  });

  test("delays the call that exceeds the window budget", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("2/s"), clock);

    await limiter.acquire();
    await limiter.acquire();
    clock.advance(200);

    // Oldest grant was at t=1000, so the slot frees at t=2000 — 800ms out.
    expect(await limiter.acquire()).toBe(800);
    expect(clock.sleeps).toEqual([800]);
  });

  test("utilization decays as the window slides", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("4/s"), clock);

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.utilization()).toBe(0.5);

    clock.advance(1_001);
    expect(limiter.utilization()).toBe(0);
  });

  test("admits a parallel burst in arrival order", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("2/s"), clock);
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map(async (i) => {
        await limiter.acquire();
        order.push(i);
      }),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("reports queue depth while calls are waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), clock);

    const first = limiter.acquire();
    const second = limiter.acquire();
    expect(limiter.queueDepth).toBe(2);

    await Promise.all([first, second]);
    expect(limiter.queueDepth).toBe(0);
  });

  test("rejects calls once the queue is full", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), { ...clock, maxQueue: 2, label: '"atlassian"' });

    const first = limiter.acquire();
    const second = limiter.acquire();
    const overflow = limiter.acquire();

    await expect(overflow).rejects.toBeInstanceOf(RateLimitQueueFullError);
    await expect(overflow).rejects.toThrow(/queue full for "atlassian"/);

    await Promise.all([first, second]);
    // Queue drained — a later call is admitted again.
    await expect(limiter.acquire()).resolves.toBeGreaterThanOrEqual(0);
  });

  test("defaults the queue cap", () => {
    expect(new RateLimiter(parseRateLimit("1/s")).queueDepth).toBe(0);
    expect(DEFAULT_RATE_LIMIT_MAX_QUEUE).toBeGreaterThan(0);
  });
});
