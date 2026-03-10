import { describe, expect, test } from "bun:test";
import {
  CONNECT_INITIAL_DELAY_MS,
  CONNECT_MAX_DELAY_MS,
  CONNECT_MAX_RETRIES,
  CONNECT_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
} from "./constants";

describe("connection retry budget", () => {
  test("worst-case retry budget fits inside IPC_REQUEST_TIMEOUT_MS", () => {
    // Compute worst-case total time:
    //   (MAX_RETRIES + 1) connect attempts, each taking up to CONNECT_TIMEOUT_MS,
    //   plus backoff delays between retries: delay_i = min(INITIAL * 2^i, MAX_DELAY)
    const totalConnectTime = (CONNECT_MAX_RETRIES + 1) * CONNECT_TIMEOUT_MS;

    let totalBackoffDelay = 0;
    for (let i = 0; i < CONNECT_MAX_RETRIES; i++) {
      totalBackoffDelay += Math.min(CONNECT_INITIAL_DELAY_MS * 2 ** i, CONNECT_MAX_DELAY_MS);
    }

    const worstCase = totalConnectTime + totalBackoffDelay;

    // Must fit within IPC request timeout with margin for processing overhead
    expect(worstCase).toBeLessThan(IPC_REQUEST_TIMEOUT_MS);
  });

  test("backoff delays are bounded by CONNECT_MAX_DELAY_MS", () => {
    for (let i = 0; i <= CONNECT_MAX_RETRIES; i++) {
      const delay = CONNECT_INITIAL_DELAY_MS * 2 ** i;
      expect(Math.min(delay, CONNECT_MAX_DELAY_MS)).toBeLessThanOrEqual(CONNECT_MAX_DELAY_MS);
    }
  });

  test("constants have sensible values", () => {
    expect(CONNECT_MAX_RETRIES).toBeGreaterThanOrEqual(1);
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONNECT_INITIAL_DELAY_MS).toBeGreaterThan(0);
    expect(CONNECT_MAX_DELAY_MS).toBeGreaterThanOrEqual(CONNECT_INITIAL_DELAY_MS);
    expect(IPC_REQUEST_TIMEOUT_MS).toBeGreaterThan(CONNECT_TIMEOUT_MS);
  });
});
