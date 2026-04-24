import { describe, expect, test } from "bun:test";
import { createBrowserLock } from "./browser-lock";

describe("createBrowserLock", () => {
  test("sequential calls execute in order", async () => {
    const withLock = createBrowserLock();
    const results: number[] = [];
    await withLock(async () => {
      results.push(1);
    });
    await withLock(async () => {
      results.push(2);
    });
    expect(results).toEqual([1, 2]);
  });

  test("concurrent calls are serialized — second waits for first to finish", async () => {
    const withLock = createBrowserLock();
    const order: string[] = [];

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const first = withLock(async () => {
      order.push("first:start");
      await firstDone;
      order.push("first:end");
    });

    // Yield so first has a chance to acquire the lock before second enqueues.
    await Promise.resolve();

    const second = withLock(async () => {
      order.push("second:start");
    });

    // Second should not have started yet (first still holds the lock).
    expect(order).toEqual(["first:start"]);

    resolveFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("lock is released after throw so subsequent callers proceed", async () => {
    const withLock = createBrowserLock();
    await expect(
      withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Should not deadlock — the next caller proceeds normally.
    const result = await withLock(async () => "ok");
    expect(result).toBe("ok");
  });

  test("models the assign-after-start pattern: browser ref is null until start() resolves", async () => {
    const withLock = createBrowserLock();

    // Simulate module-level state (fixed pattern from #1705).
    let isRunning = false;
    class FakeEngine {}
    const fakeEngine = new FakeEngine();
    let browserRef: FakeEngine | null = null;

    function resetIfDied() {
      if (browserRef && !isRunning) {
        browserRef = null;
      }
    }

    // Simulate handleBrowserStart: eng is created by loadBrowser (local only),
    // browserRef is assigned only after eng.start() resolves.
    let resolveStart!: () => void;
    const startDone = new Promise<void>((r) => {
      resolveStart = r;
    });

    const startTask = withLock(async () => {
      resetIfDied();
      const eng = fakeEngine; // loadBrowser returns engine without setting browserRef
      await startDone; // eng.start()
      isRunning = true;
      browserRef = eng; // assign only after start succeeds
    });

    // Yield so startTask acquires the lock.
    await Promise.resolve();

    // Simulate a concurrent observer (e.g. handleWiggle) trying to reset.
    const observerTask = withLock(async () => {
      resetIfDied();
      return browserRef;
    });

    // startTask holds the lock; browserRef is still null during start().
    expect(browserRef).toBeNull();
    expect(isRunning).toBe(false);

    resolveStart();
    await startTask;

    const observerSaw = await observerTask;

    // Observer runs after start completes; browserRef is set and isRunning=true.
    expect(observerSaw === fakeEngine).toBe(true);
    expect(browserRef === fakeEngine).toBe(true);
  });

  test("models start() failure: browser ref stays null when start throws", async () => {
    const withLock = createBrowserLock();

    class FakeEngine {}
    const fakeEngine = new FakeEngine();
    let browserRef: FakeEngine | null = null;

    // Simulate handleBrowserStart where eng.start() throws.
    await expect(
      withLock(async () => {
        const eng = fakeEngine; // loadBrowser returns engine without setting browserRef
        void eng; // would call eng.start() here
        throw new Error("start timed out");
        // browserRef is never assigned
      }),
    ).rejects.toThrow("start timed out");

    expect(browserRef).toBeNull();

    // Lock is released; next caller can proceed.
    const result = await withLock(async () => browserRef);
    expect(result).toBeNull();
  });
});
