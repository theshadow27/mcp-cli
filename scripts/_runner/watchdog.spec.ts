import { describe, expect, it } from "bun:test";

import { findDescendantPids, parseEtime, startWatchdog } from "./watchdog";

describe("parseEtime", () => {
  it("parses MM:SS format", () => {
    expect(parseEtime("01:30")).toBe(90);
    expect(parseEtime("00:05")).toBe(5);
  });

  it("parses HH:MM:SS format", () => {
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("00:10:00")).toBe(600);
  });

  it("parses DD-HH:MM:SS format", () => {
    expect(parseEtime("1-00:00:00")).toBe(86400);
    expect(parseEtime("2-01:30:45")).toBe(2 * 86400 + 1 * 3600 + 30 * 60 + 45);
  });

  it("handles whitespace-padded etime", () => {
    expect(parseEtime("   03:15  ")).toBe(195);
  });

  it("returns 0 for empty/unparseable input", () => {
    expect(parseEtime("")).toBe(0);
    expect(parseEtime("x")).toBe(0);
  });
});

describe("findDescendantPids", () => {
  it("finds descendants of the current process", () => {
    const descendants = findDescendantPids(process.pid);
    // Current process may or may not have children during test, but the
    // function should return a Set without throwing
    expect(descendants).toBeInstanceOf(Set);
  });

  it("returns empty set for a non-existent PID", () => {
    const descendants = findDescendantPids(999999999);
    expect(descendants.size).toBe(0);
  });

  it("finds pid 1's descendants (init/launchd always has children)", () => {
    const descendants = findDescendantPids(1);
    expect(descendants.size).toBeGreaterThan(0);
  });
});

describe("startWatchdog", () => {
  it("starts and stops without error", () => {
    const handle = startWatchdog({
      parentPid: process.pid,
      elapsedThresholdSeconds: 9999,
      pollIntervalMs: 60_000,
    });
    expect(handle.killed).toBe(0);
    handle.stop();
  });

  it("does not kill short-lived processes", async () => {
    const POLL_MS = 100;
    const handle = startWatchdog({
      parentPid: process.pid,
      elapsedThresholdSeconds: 9999,
      pollIntervalMs: POLL_MS,
    });

    // Wait for at least two poll cycles
    await Bun.sleep(POLL_MS * 3);
    expect(handle.killed).toBe(0);
    handle.stop();
  });
});
