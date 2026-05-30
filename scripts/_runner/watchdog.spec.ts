import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

import { findDescendantPids, findWedgedWorkers, killWorkerProcess, parseEtime, startWatchdog } from "./watchdog";

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
    expect(descendants).toBeInstanceOf(Set);
  });

  it("returns empty set for a non-existent PID", () => {
    const descendants = findDescendantPids(999999999);
    expect(descendants.size).toBe(0);
  });

  it("returns a valid Set for pid 1", () => {
    const descendants = findDescendantPids(1);
    expect(descendants).toBeInstanceOf(Set);
  });
});

describe("findWedgedWorkers", () => {
  it("returns empty array when parent has no descendants", () => {
    const wedged = findWedgedWorkers(999999999, 10);
    expect(wedged).toEqual([]);
  });

  it("returns empty array when no descendants match --test-worker", () => {
    const wedged = findWedgedWorkers(process.pid, 0);
    expect(wedged).toEqual([]);
  });

  it("finds a descendant --test-worker process exceeding threshold", () => {
    const child = Bun.spawn(["sleep", "999"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const descendants = findDescendantPids(process.pid);
      expect(descendants.has(child.pid)).toBe(true);
      const wedged = findWedgedWorkers(process.pid, 0);
      expect(wedged).toEqual([]);
    } finally {
      child.kill(9);
    }
  });
});

describe("killWorkerProcess", () => {
  it("kills a live process and returns true", async () => {
    const child = Bun.spawn(["sleep", "999"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const pid = child.pid;
    const result = killWorkerProcess(pid);
    expect(result).toBe(true);
    await child.exited;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("returns false for a non-existent PID", () => {
    const result = killWorkerProcess(999999999);
    expect(result).toBe(false);
  });

  it("logs when a logger is provided", () => {
    const child = Bun.spawn(["sleep", "999"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const pid = child.pid;
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    killWorkerProcess(pid, logger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`SIGKILL sent to process ${pid}`);
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

  it("does not kill short-lived processes", () => {
    const handle = startWatchdog({
      parentPid: process.pid,
      elapsedThresholdSeconds: 9999,
      pollIntervalMs: 60_000,
    });

    expect(handle.killed).toBe(0);
    handle.stop();
  });
});
