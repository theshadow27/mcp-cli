import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "am-i-done/tmp";
import { spawnHeadless } from "./headless";

const POLL_MS = 10;

describe("spawnHeadless with real spawn", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tmpDir("mcp-headless-test-").join("work");
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

    // Poll until the process finishes writing the log file
    const deadline = Date.now() + 2_000;
    let logContent = "";
    while (Date.now() < deadline) {
      try {
        logContent = readFileSync(result.logFile, "utf-8");
        if (logContent.includes("headless-test-output")) break;
        // doing-it-wrong-ignore test-empty-catch: parse-probe — file may not exist yet during poll (#3465)
      } catch {
        // File may not exist yet
      }
      await Bun.sleep(POLL_MS);
    }
    expect(logContent).toContain("headless-test-output");
  });
});
