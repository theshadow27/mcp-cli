import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHeadless } from "./headless";

describe("spawnHeadless with real spawn", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-headless-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("spawns a real process and captures output to log file", async () => {
    const result = await spawnHeadless("echo headless-test-output", undefined, testDir);

    expect(result.pid).toBeGreaterThan(0);
    expect(result.logFile).toContain(testDir);

    // Wait for the process to finish writing
    await Bun.sleep(200);

    const logContent = readFileSync(result.logFile, "utf-8");
    expect(logContent).toContain("headless-test-output");
  });
});
