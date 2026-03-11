import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESTART_POLICY,
  type RestartPolicy,
  getBackoffDelay,
  maxAttempts,
  shouldRestart,
} from "./restart-policy";

// ── DEFAULT_RESTART_POLICY ──

describe("DEFAULT_RESTART_POLICY", () => {
  test("has sensible defaults", () => {
    expect(DEFAULT_RESTART_POLICY.maxCrashes).toBe(3);
    expect(DEFAULT_RESTART_POLICY.crashWindowMs).toBe(60_000);
    expect(DEFAULT_RESTART_POLICY.backoffDelaysMs).toEqual([100, 500, 2000]);
  });
});

// ── shouldRestart ──

describe("shouldRestart", () => {
  const policy: RestartPolicy = { maxCrashes: 3, crashWindowMs: 60_000, backoffDelaysMs: [] };

  test("allows restarts up to maxCrashes", () => {
    const timestamps: number[] = [];
    const now = 1000;
    expect(shouldRestart(timestamps, policy, now)).toBe(true); // 1st
    expect(shouldRestart(timestamps, policy, now + 1)).toBe(true); // 2nd
    expect(shouldRestart(timestamps, policy, now + 2)).toBe(true); // 3rd (at limit)
  });

  test("rejects restart when exceeding maxCrashes within window", () => {
    const timestamps: number[] = [];
    const now = 1000;
    shouldRestart(timestamps, policy, now);
    shouldRestart(timestamps, policy, now + 1);
    shouldRestart(timestamps, policy, now + 2);
    // 4th crash within window → over budget
    expect(shouldRestart(timestamps, policy, now + 3)).toBe(false);
  });

  test("trims old timestamps outside the window", () => {
    const timestamps: number[] = [];
    const now = 1000;
    // 3 crashes at t=1000
    shouldRestart(timestamps, policy, now);
    shouldRestart(timestamps, policy, now + 1);
    shouldRestart(timestamps, policy, now + 2);

    // After window passes, old timestamps are trimmed — budget resets
    // Window boundary at future - 60_000 = now + 3, so now and now+1 are trimmed,
    // now+2 (1002) is still within window (1002 > 1002 is false, so NOT trimmed).
    const future = now + 60_003;
    expect(shouldRestart(timestamps, policy, future)).toBe(true);
    expect(timestamps.length).toBe(1); // only the new one
  });

  test("handles partial window expiration", () => {
    const timestamps: number[] = [];
    // 3 crashes at different times
    shouldRestart(timestamps, policy, 1000);
    shouldRestart(timestamps, policy, 30_000);
    shouldRestart(timestamps, policy, 50_000);

    // At t=61_001, first crash (t=1000) is outside window but others are inside
    // So we have 2 old + 1 new = 3 within window → still OK
    expect(shouldRestart(timestamps, policy, 61_001)).toBe(true);
    expect(timestamps.length).toBe(3); // t=30000, t=50000, t=61001
  });

  test("mutates the crashTimestamps array", () => {
    const timestamps: number[] = [];
    shouldRestart(timestamps, policy, 100);
    expect(timestamps).toEqual([100]);
    shouldRestart(timestamps, policy, 200);
    expect(timestamps).toEqual([100, 200]);
  });

  test("empty timestamps always allows restart", () => {
    expect(shouldRestart([], policy, 0)).toBe(true);
  });

  test("maxCrashes=1 allows exactly one crash", () => {
    const strict: RestartPolicy = { maxCrashes: 1, crashWindowMs: 10_000, backoffDelaysMs: [] };
    const timestamps: number[] = [];
    expect(shouldRestart(timestamps, strict, 0)).toBe(true);
    expect(shouldRestart(timestamps, strict, 1)).toBe(false);
  });

  test("clearing timestamps resets crash budget", () => {
    const timestamps: number[] = [];
    shouldRestart(timestamps, policy, 1000);
    shouldRestart(timestamps, policy, 1001);
    shouldRestart(timestamps, policy, 1002);
    // 4th would fail
    expect(shouldRestart(timestamps, policy, 1003)).toBe(false);

    // Clear (simulates stop()) and try again
    timestamps.length = 0;
    expect(shouldRestart(timestamps, policy, 2000)).toBe(true);
    expect(shouldRestart(timestamps, policy, 2001)).toBe(true);
    expect(shouldRestart(timestamps, policy, 2002)).toBe(true);
  });
});

// ── getBackoffDelay ──

describe("getBackoffDelay", () => {
  const delays = [100, 500, 2000];

  test("attempt 0 returns 0 (no delay)", () => {
    expect(getBackoffDelay(0, delays)).toBe(0);
  });

  test("attempt 1 returns first backoff", () => {
    expect(getBackoffDelay(1, delays)).toBe(100);
  });

  test("attempt 2 returns second backoff", () => {
    expect(getBackoffDelay(2, delays)).toBe(500);
  });

  test("attempt 3 returns third backoff", () => {
    expect(getBackoffDelay(3, delays)).toBe(2000);
  });

  test("attempt beyond schedule length clamps to last value", () => {
    expect(getBackoffDelay(4, delays)).toBe(2000);
    expect(getBackoffDelay(10, delays)).toBe(2000);
  });

  test("negative attempt returns 0", () => {
    expect(getBackoffDelay(-1, delays)).toBe(0);
  });

  test("empty delays falls back to 2000", () => {
    expect(getBackoffDelay(1, [])).toBe(2000);
  });
});

// ── maxAttempts ──

describe("maxAttempts", () => {
  test("returns backoff length + 1 (initial attempt + retries)", () => {
    expect(maxAttempts(DEFAULT_RESTART_POLICY)).toBe(4);
  });

  test("single backoff entry gives 2 attempts", () => {
    expect(maxAttempts({ maxCrashes: 3, crashWindowMs: 60_000, backoffDelaysMs: [500] })).toBe(2);
  });

  test("no backoff entries gives 1 attempt", () => {
    expect(maxAttempts({ maxCrashes: 3, crashWindowMs: 60_000, backoffDelaysMs: [] })).toBe(1);
  });
});
