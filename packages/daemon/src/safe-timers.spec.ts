import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { safeSetInterval, safeSetTimeout } from "./safe-timers";

const POLL_INTERVAL_MS = 5;

async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

describe("safeSetTimeout", () => {
  const captured: string[] = [];
  let origConsoleError: typeof console.error;

  beforeEach(() => {
    origConsoleError = console.error;
    console.error = (...args: unknown[]) => captured.push(String(args[0]));
  });

  afterEach(() => {
    console.error = origConsoleError;
    captured.length = 0;
  });

  test("runs a sync callback normally", async () => {
    let called = false;
    safeSetTimeout(() => {
      called = true;
    }, 0);
    await pollUntil(() => called);
    expect(captured).toHaveLength(0);
  });

  test("catches sync throw and logs via default handler", async () => {
    safeSetTimeout(() => {
      throw new Error("boom");
    }, 0);
    await pollUntil(() => captured.length > 0);
    expect(captured[0]).toContain("boom");
    expect(captured[0]).toContain("[safe-timer]");
  });

  test("catches async rejection and logs via default handler", async () => {
    safeSetTimeout(async () => {
      throw new Error("async-boom");
    }, 0);
    await pollUntil(() => captured.length > 0);
    expect(captured[0]).toContain("async-boom");
  });

  test("routes errors to custom onError when provided", async () => {
    const errors: unknown[] = [];
    safeSetTimeout(
      () => {
        throw new Error("custom");
      },
      0,
      (e) => errors.push(e),
    );
    await pollUntil(() => errors.length > 0);
    expect((errors[0] as Error).message).toBe("custom");
    expect(captured).toHaveLength(0);
  });

  test("returns a clearable timer", async () => {
    let called = false;
    const delayMs = 50;
    const timer = safeSetTimeout(() => {
      called = true;
    }, delayMs);
    clearTimeout(timer);
    // Wait long enough that the timer would have fired
    const waitMs = delayMs * 3;
    await Bun.sleep(waitMs);
    expect(called).toBe(false);
  });

  test("falls back to default handler when custom onError throws", async () => {
    safeSetTimeout(
      () => {
        throw new Error("original");
      },
      0,
      () => {
        throw new Error("handler-broke");
      },
    );
    await pollUntil(() => captured.length >= 2);
    expect(captured[0]).toContain("original");
    expect(captured[1]).toContain("handler-broke");
  });

  test("handles non-Error throws", async () => {
    safeSetTimeout(() => {
      throw "string-error"; // eslint-disable-line no-throw-literal
    }, 0);
    await pollUntil(() => captured.length > 0);
    expect(captured[0]).toContain("string-error");
  });
});

describe("safeSetInterval", () => {
  const captured: string[] = [];
  let origConsoleError: typeof console.error;
  let timer: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    origConsoleError = console.error;
    console.error = (...args: unknown[]) => captured.push(String(args[0]));
  });

  afterEach(() => {
    console.error = origConsoleError;
    captured.length = 0;
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  test("runs repeatedly and catches errors each time", async () => {
    let calls = 0;
    timer = safeSetInterval(() => {
      calls++;
      if (calls === 2) throw new Error("interval-boom");
    }, 20);
    await pollUntil(() => calls >= 3);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("interval-boom");
  });

  test("catches async rejection in interval callback", async () => {
    let calls = 0;
    timer = safeSetInterval(async () => {
      calls++;
      if (calls === 1) throw new Error("async-interval-boom");
    }, 20);
    await pollUntil(() => captured.length > 0);
    expect(captured[0]).toContain("async-interval-boom");
    expect(captured[0]).toContain("[safe-timer]");
    await pollUntil(() => calls >= 2); // interval continues after async rejection
  });

  test("returns a clearable interval", async () => {
    let calls = 0;
    timer = safeSetInterval(() => {
      calls++;
    }, 10);
    await pollUntil(() => calls >= 3);
    clearInterval(timer);
    timer = undefined;
    const snapshot = calls;
    const waitMs = 80;
    await Bun.sleep(waitMs);
    expect(calls).toBe(snapshot);
  });
});
