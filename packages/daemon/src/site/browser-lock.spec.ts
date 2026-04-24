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

  test("models the reset-during-start race: observer cannot clear browser while start holds the lock", async () => {
    const withLock = createBrowserLock();

    // Simulate module-level state.
    let isRunning = false;
    class FakeEngine {}
    const fakeEngine = new FakeEngine();
    let browserRef: FakeEngine | null = null;

    function resetIfDied() {
      if (browserRef && !isRunning) {
        browserRef = null;
      }
    }

    // Simulate handleBrowserStart holding the lock across the async start.
    let resolveStart!: () => void;
    const startDone = new Promise<void>((r) => {
      resolveStart = r;
    });

    const startTask = withLock(async () => {
      resetIfDied();
      browserRef = fakeEngine; // loadBrowser assigns the ref
      await startDone; // eng.start() — async gap where observer would race
      isRunning = true;
    });

    // Yield so startTask acquires the lock.
    await Promise.resolve();

    // Simulate a concurrent observer (e.g. handleWiggle) trying to reset.
    const observerTask = withLock(async () => {
      resetIfDied();
      return browserRef;
    });

    // At this point startTask holds the lock; observerTask is queued.
    // browserRef is truthy but isRunning is still false —
    // without the lock the observer would clear browserRef here.
    expect(browserRef === fakeEngine).toBe(true);
    expect(isRunning).toBe(false);

    // Finish the start.
    resolveStart();
    await startTask;

    const observerSaw = await observerTask;

    // isRunning=true by the time observer runs → reset does NOT fire.
    expect(observerSaw === fakeEngine).toBe(true);
    expect(browserRef === fakeEngine).toBe(true);
  });
});
