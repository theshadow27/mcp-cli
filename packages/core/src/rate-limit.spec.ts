import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RATE_LIMIT_MAX_QUEUE,
  MAX_RATE_LIMIT_WINDOW_MS,
  MAX_TIMER_DELAY_MS,
  RateLimitAbortedError,
  RateLimitDeadlineError,
  RateLimitQueueFullError,
  RateLimiter,
  clampTimerDelay,
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

  // A window past setTimeout's 32-bit ceiling does not wait longer — the timer
  // clamps to 1ms and the wait loop becomes a hot spin. Reject at parse time.
  test("rejects a window beyond the 24h ceiling", () => {
    expect(() => parseRateLimit("1/1000h")).toThrow(/exceeds the .* maximum/);
    expect(() => parseRateLimit("1/25h")).toThrow(/Invalid rate limit/);
  });

  test("accepts the ceiling itself", () => {
    expect(parseRateLimit("1/24h").windowMs).toBe(MAX_RATE_LIMIT_WINDOW_MS);
    expect(MAX_RATE_LIMIT_WINDOW_MS).toBeLessThan(MAX_TIMER_DELAY_MS);
  });
});

describe("clampTimerDelay", () => {
  test("clamps above the 32-bit timer ceiling instead of wrapping to 1ms", () => {
    expect(clampTimerDelay(3_600_000_000)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelay(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
  });

  test("floors non-positive and NaN delays at zero, clamps infinity", () => {
    expect(clampTimerDelay(-5)).toBe(0);
    expect(clampTimerDelay(Number.NaN)).toBe(0);
    expect(clampTimerDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY_MS);
  });

  test("passes ordinary delays through, truncated to whole ms", () => {
    expect(clampTimerDelay(1_500)).toBe(1_500);
    expect(clampTimerDelay(10.9)).toBe(10);
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
    expect(new RateLimiter(parseRateLimit("1/s")).maxQueue).toBe(DEFAULT_RATE_LIMIT_MAX_QUEUE);
  });

  test("never sleeps longer than setTimeout honors", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ count: 1, windowMs: 3_600_000_000, source: "1/1000h" }, clock);

    await limiter.acquire();
    const queued = limiter.acquire();
    // One clamped sleep, not a spin: the loop must not run again until it elapses.
    await Promise.resolve();
    expect(clock.sleeps).toEqual([MAX_TIMER_DELAY_MS]);
    await queued;
  });
});

describe("RateLimiter deadlines", () => {
  test("admits immediately when the budget is free", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("2/s"), clock);

    await expect(limiter.acquire({ deadlineMs: clock.now() + 10 })).resolves.toBe(0);
  });

  test("rejects rather than waiting past the caller's deadline", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), { ...clock, label: '"atlassian"' });

    await limiter.acquire();
    // The next slot frees in 1000ms; the caller only has 200ms left.
    const rejected = limiter.acquire({ deadlineMs: clock.now() + 200 });
    await expect(rejected).rejects.toBeInstanceOf(RateLimitDeadlineError);
    await expect(rejected).rejects.toThrow(/call not made/);
    // Nothing slept: the call was refused, not performed late.
    expect(clock.sleeps).toEqual([]);
  });

  test("waits when the projected admission fits inside the deadline", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), clock);

    await limiter.acquire();
    await expect(limiter.acquire({ deadlineMs: clock.now() + 5_000 })).resolves.toBeGreaterThan(0);
  });

  // The leak the deadline check exists to close: a waiter that can never be
  // admitted in time must not occupy a slot that a live call needs.
  test("a deadline-doomed call takes no queue slot", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), { ...clock, maxQueue: 2 });

    await limiter.acquire();
    const waiting = limiter.acquire();
    expect(limiter.queueDepth).toBe(1);

    // Doomed by its deadline — and refused for that reason, not by the cap.
    await expect(limiter.acquire({ deadlineMs: clock.now() + 1 })).rejects.toBeInstanceOf(RateLimitDeadlineError);
    expect(limiter.queueDepth).toBe(1);

    // The slot the doomed caller would have squatted is still available to a
    // live call, which would otherwise have hit RateLimitQueueFullError.
    const live = limiter.acquire({ deadlineMs: clock.now() + 10_000 });
    expect(limiter.queueDepth).toBe(2);
    await Promise.all([waiting, live]);
  });

  test("projects the wait across waiters already queued ahead", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("1/s"), clock);

    const inflight = [limiter.acquire(), limiter.acquire(), limiter.acquire()];
    // Fourth in line cannot be admitted for ~3 windows, so a 2.5s deadline fails
    // even though the *next* slot frees well inside it.
    await expect(limiter.acquire({ deadlineMs: clock.now() + 2_500 })).rejects.toBeInstanceOf(RateLimitDeadlineError);
    await expect(limiter.acquire({ deadlineMs: clock.now() + 3_500 })).resolves.toBeGreaterThan(0);
    await Promise.all(inflight);
  });

  test("refuses a caller that is already aborted", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(parseRateLimit("5/s"), clock);

    await expect(limiter.acquire({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RateLimitAbortedError);
    // No slot was spent on a call nobody is waiting for.
    expect(limiter.utilization()).toBe(0);
  });

  test("aborting mid-wait releases the slot and never admits the call", async () => {
    const clock = fakeClock();
    // Real sleep so the abort can land while the waiter is parked.
    const limiter = new RateLimiter(parseRateLimit("1/s"), { now: clock.now, label: '"atlassian"' });
    const controller = new AbortController();

    await limiter.acquire();
    const queued = limiter.acquire({ signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(RateLimitAbortedError);
    expect(limiter.queueDepth).toBe(0);
    // Only the first call consumed budget.
    expect(limiter.utilization()).toBe(1);
  });

  test("an aborted waiter does not block the waiter behind it", async () => {
    const limiter = new RateLimiter(parseRateLimit("2/500ms"));
    const controller = new AbortController();

    await limiter.acquire();
    await limiter.acquire();
    const aborted = limiter.acquire({ signal: controller.signal });
    const survivor = limiter.acquire();
    controller.abort();

    await expect(aborted).rejects.toBeInstanceOf(RateLimitAbortedError);
    await expect(survivor).resolves.toBeGreaterThan(0);
  });
});
