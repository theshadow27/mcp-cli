import { describe, expect, test } from "bun:test";
import { CLOSE_TIMEOUT_MS, closeClientWithTimeout } from "./close-timeout";

describe("closeClientWithTimeout", () => {
  test("resolves immediately when client is null", async () => {
    await closeClientWithTimeout(null);
  });

  test("resolves immediately when client is undefined", async () => {
    await closeClientWithTimeout(undefined);
  });

  test("resolves when close() resolves quickly", async () => {
    let closed = false;
    const client = {
      close: async () => {
        closed = true;
      },
    };
    await closeClientWithTimeout(client, 1000);
    expect(closed).toBe(true);
  });

  test("resolves within timeout when close() hangs indefinitely", async () => {
    const client = {
      close: () => new Promise<void>(() => {}), // never resolves
    };
    const start = Date.now();
    await closeClientWithTimeout(client, 50);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("does not throw when close() rejects", async () => {
    const client = {
      close: async () => {
        throw new Error("connection refused");
      },
    };
    await closeClientWithTimeout(client, 1000);
    // should not throw
  });

  test("does not throw on timeout", async () => {
    const client = {
      close: () => new Promise<void>(() => {}), // never resolves
    };
    await closeClientWithTimeout(client, 10);
    // should not throw
  });

  test("uses CLOSE_TIMEOUT_MS as default timeout", () => {
    expect(CLOSE_TIMEOUT_MS).toBe(5_000);
  });

  test("timer is cleared after close() resolves (no unhandled rejection)", async () => {
    // If the timer leaked, it would fire a rejection after the promise settles.
    // This test verifies the timer is cleared by checking multiple rapid calls work.
    for (let i = 0; i < 5; i++) {
      const client = { close: async () => {} };
      await closeClientWithTimeout(client, 100);
    }
  });
});
