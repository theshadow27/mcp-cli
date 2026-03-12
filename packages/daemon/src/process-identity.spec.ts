import { describe, expect, test } from "bun:test";
import { getProcessStartTime, isOurProcess } from "./process-identity";

describe("getProcessStartTime", () => {
  test("returns a number for the current process", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).toBeNumber();
    expect(startTime).toBeGreaterThan(0);
  });

  test("returns null for a non-existent PID", () => {
    // PID 2147483647 is extremely unlikely to exist
    const startTime = getProcessStartTime(2147483647);
    expect(startTime).toBeNull();
  });

  test("returns consistent values across calls for the same process", () => {
    const t1 = getProcessStartTime(process.pid);
    const t2 = getProcessStartTime(process.pid);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    // Should be within 1 second of each other (same process, same start time)
    expect(Math.abs((t1 as number) - (t2 as number))).toBeLessThanOrEqual(1000);
  });
});

describe("isOurProcess", () => {
  test("returns true for the current process with correct start time", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    expect(isOurProcess(process.pid, startTime as number)).toBe(true);
  });

  test("returns false for a dead PID", () => {
    expect(isOurProcess(2147483647, Date.now())).toBe(false);
  });

  test("returns false when start time doesn't match (simulates PID reuse)", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    // Use a time 1 hour before the actual start time
    const fakeStartTime = (startTime as number) - 3600_000;
    expect(isOurProcess(process.pid, fakeStartTime)).toBe(false);
  });

  test("respects tolerance parameter", () => {
    const startTime = getProcessStartTime(process.pid) as number;
    expect(startTime).not.toBeNull();
    // Exact match should work with 0 tolerance
    expect(isOurProcess(process.pid, startTime, 0)).toBe(true);
    // A significantly different time should fail with tight tolerance
    expect(isOurProcess(process.pid, startTime + 5000, 1000)).toBe(false);
  });
});
