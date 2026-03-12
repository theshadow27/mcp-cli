import { describe, expect, test } from "bun:test";
import {
  findDeadPids,
  getProcessStartTime,
  getProcessStartTimesBatch,
  isOurProcess,
  parseEtime,
} from "./process-identity";

describe("parseEtime", () => {
  test("parses seconds only", () => {
    expect(parseEtime("42")).toBe(42);
  });

  test("parses mm:ss", () => {
    expect(parseEtime("05:30")).toBe(330);
  });

  test("parses hh:mm:ss", () => {
    expect(parseEtime("02:05:30")).toBe(7530);
  });

  test("parses dd-hh:mm:ss", () => {
    expect(parseEtime("3-02:05:30")).toBe(3 * 86400 + 7530);
  });

  test("handles leading whitespace", () => {
    expect(parseEtime("   05:30")).toBe(330);
  });

  test("returns null for empty string", () => {
    expect(parseEtime("")).toBeNull();
  });

  test("returns null for garbage", () => {
    expect(parseEtime("abc")).toBeNull();
  });

  test("parses single-digit fields like 0:00", () => {
    expect(parseEtime("0:00")).toBe(0);
  });
});

describe("getProcessStartTime", () => {
  test("returns a number for the current process", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).toBeNumber();
    expect(startTime).toBeGreaterThan(0);
  });

  test("returns null for a non-existent PID", () => {
    const startTime = getProcessStartTime(2147483647);
    expect(startTime).toBeNull();
  });

  test("returns consistent values across calls for the same process", () => {
    const t1 = getProcessStartTime(process.pid);
    const t2 = getProcessStartTime(process.pid);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    // etime has 1s granularity — two calls may straddle a boundary
    expect(Math.abs((t1 as number) - (t2 as number))).toBeLessThanOrEqual(2000);
  });
});

describe("getProcessStartTimesBatch", () => {
  test("returns start time for the current process", () => {
    const result = getProcessStartTimesBatch([process.pid]);
    expect(result.has(process.pid)).toBe(true);
    expect(result.get(process.pid)).toBeGreaterThan(0);
  });

  test("omits non-existent PIDs", () => {
    // Use a PID that's valid but very unlikely to exist (not out of range)
    const deadPid = 99999;
    const result = getProcessStartTimesBatch([process.pid, deadPid]);
    expect(result.has(process.pid)).toBe(true);
    expect(result.has(deadPid)).toBe(false);
  });

  test("returns empty map for empty input", () => {
    const result = getProcessStartTimesBatch([]);
    expect(result.size).toBe(0);
  });

  test("batch result is consistent with single-call result", () => {
    const single = getProcessStartTime(process.pid);
    const batch = getProcessStartTimesBatch([process.pid]);
    expect(single).not.toBeNull();
    expect(batch.has(process.pid)).toBe(true);
    // Both derive from etime — within 2s tolerance
    const batchValue = batch.get(process.pid) as number;
    expect(Math.abs((single as number) - batchValue)).toBeLessThanOrEqual(2000);
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
    const fakeStartTime = (startTime as number) - 3600_000;
    expect(isOurProcess(process.pid, fakeStartTime)).toBe(false);
  });

  test("respects tolerance parameter", () => {
    const startTime = getProcessStartTime(process.pid) as number;
    expect(startTime).not.toBeNull();
    // Within tolerance should pass
    expect(isOurProcess(process.pid, startTime, 3000)).toBe(true);
    // A significantly different time should fail with tight tolerance
    expect(isOurProcess(process.pid, startTime + 5000, 1000)).toBe(false);
  });
});

describe("findDeadPids", () => {
  test("returns empty set for empty input", () => {
    const result = findDeadPids(new Map());
    expect(result.size).toBe(0);
  });

  test("does not include live PIDs with correct start times", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    const result = findDeadPids(new Map([[process.pid, startTime as number]]));
    expect(result.has(process.pid)).toBe(false);
  });

  test("includes dead PIDs", () => {
    const result = findDeadPids(new Map([[2147483647, Date.now()]]));
    expect(result.has(2147483647)).toBe(true);
  });

  test("includes PIDs with mismatched start times", () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    const result = findDeadPids(new Map([[process.pid, (startTime as number) - 3600_000]]));
    expect(result.has(process.pid)).toBe(true);
  });
});
