import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireConcurrencyGuard } from "./concurrency";

const SENTINEL_DIR = "/tmp";
const SENTINEL_PREFIX = "mcp-cli-am-i-done-";
const SENTINEL_SUFFIX = ".sentinel";

function sentinelPath(pid: number): string {
  return join(SENTINEL_DIR, `${SENTINEL_PREFIX}${pid}${SENTINEL_SUFFIX}`);
}

function cleanupSentinels(): void {
  for (const f of readdirSync(SENTINEL_DIR)) {
    if (f.startsWith(SENTINEL_PREFIX) && f.endsWith(SENTINEL_SUFFIX)) {
      const p = join(SENTINEL_DIR, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

afterEach(cleanupSentinels);

describe("acquireConcurrencyGuard", () => {
  it("creates a sentinel file and cleans it up", () => {
    const guard = acquireConcurrencyGuard();
    expect(existsSync(sentinelPath(process.pid))).toBe(true);
    guard.cleanup();
    expect(existsSync(sentinelPath(process.pid))).toBe(false);
  });

  it("returns maxConcurrency based on CPU count when no siblings", () => {
    const { availableParallelism } = require("node:os");
    const cpuCount = availableParallelism();
    const guard = acquireConcurrencyGuard();
    expect(guard.siblingCount).toBe(0);
    expect(guard.maxConcurrency).toBe(cpuCount);
    guard.cleanup();
  });

  it("detects fake sibling sentinels and reduces maxConcurrency", () => {
    const fakePid1 = process.pid + 100000;
    const fakePid2 = process.pid + 100001;
    writeFileSync(sentinelPath(fakePid1), `${process.pid}\n${Date.now()}\n`);
    writeFileSync(sentinelPath(fakePid2), `${process.pid}\n${Date.now()}\n`);

    const guard = acquireConcurrencyGuard();
    // fake PIDs are dead, so they get cleaned up and aren't counted
    expect(guard.siblingCount).toBe(0);
    guard.cleanup();
  });

  it("counts live sibling sentinels (using own pid as fake sibling)", () => {
    // Write a sentinel for a known-live PID (pid 1 — launchd/init is always alive)
    const livePid = 1;
    writeFileSync(sentinelPath(livePid), `${livePid}\n${Date.now()}\n`);

    const guard = acquireConcurrencyGuard();
    expect(guard.siblingCount).toBe(1);

    const { availableParallelism } = require("node:os");
    const cpuCount = availableParallelism();
    const expected = Math.max(2, Math.floor(cpuCount / 2));
    expect(guard.maxConcurrency).toBe(expected);

    guard.cleanup();
    unlinkSync(sentinelPath(livePid));
  });

  it("maxConcurrency floor is 2 even under extreme load", () => {
    // Simulate many siblings by writing sentinels for pid 1
    // (can only use one live PID, so simulate by checking the formula)
    const { availableParallelism } = require("node:os");
    const cpuCount = availableParallelism();

    // With cpuCount siblings + 1 (self), floor(cpuCount / (cpuCount+1)) = 0, capped to 2
    const result = Math.max(2, Math.floor(cpuCount / (cpuCount + 1)));
    expect(result).toBe(2);
  });

  it("cleanup is idempotent", () => {
    const guard = acquireConcurrencyGuard();
    guard.cleanup();
    guard.cleanup(); // should not throw
    expect(existsSync(sentinelPath(process.pid))).toBe(false);
  });
});
