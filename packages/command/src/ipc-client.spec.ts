import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PID_MAX_AGE_MS } from "@mcp-cli/core";
import { isDaemonRunning, isProcessMcpd } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options.js";

describe("PID staleness detection", () => {
  describe("isProcessMcpd", () => {
    test("returns false for PID 1 (launchd/init)", () => {
      expect(isProcessMcpd(1)).toBe(false);
    });

    test("returns false for non-existent PID", () => {
      expect(isProcessMcpd(4294967)).toBe(false);
    });

    test("returns false for current process (bun test runner)", () => {
      // The test runner is bun, not mcpd
      expect(isProcessMcpd(process.pid)).toBe(false);
    });
  });

  describe("isDaemonRunning", () => {
    test("returns false when no PID file exists", async () => {
      using opts = testOptions();
      // PID file doesn't exist in fresh temp dir
      expect(await isDaemonRunning()).toBe(false);
    });

    test("returns false and cleans up for invalid JSON in PID file", async () => {
      using opts = testOptions();
      mkdirSync(dirname(opts.PID_PATH), { recursive: true });
      writeFileSync(opts.PID_PATH, "not valid json{{{");
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(opts.PID_PATH)).toBe(false);
    });

    test("returns false and cleans up for PID file older than max age", async () => {
      using opts = testOptions();
      const staleData = {
        pid: process.pid,
        configHash: "abc123",
        startedAt: Date.now() - PID_MAX_AGE_MS - 1000,
      };
      mkdirSync(dirname(opts.PID_PATH), { recursive: true });
      writeFileSync(opts.PID_PATH, JSON.stringify(staleData));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(opts.PID_PATH)).toBe(false);
    });

    test("returns false and cleans up for missing startedAt field", async () => {
      using opts = testOptions();
      const badData = { pid: process.pid, configHash: "abc123" };
      mkdirSync(dirname(opts.PID_PATH), { recursive: true });
      writeFileSync(opts.PID_PATH, JSON.stringify(badData));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(opts.PID_PATH)).toBe(false);
    });

    test("returns false and cleans up when process does not exist", async () => {
      using opts = testOptions();
      const data = {
        pid: 4294967, // very unlikely to be a real process
        configHash: "abc123",
        startedAt: Date.now(),
      };
      mkdirSync(dirname(opts.PID_PATH), { recursive: true });
      writeFileSync(opts.PID_PATH, JSON.stringify(data));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(opts.PID_PATH)).toBe(false);
    });

    test("returns false when PID belongs to a non-mcpd process", async () => {
      using opts = testOptions();
      // Current process is bun (test runner), not mcpd
      const data = {
        pid: process.pid,
        configHash: "abc123",
        startedAt: Date.now(),
      };
      mkdirSync(dirname(opts.PID_PATH), { recursive: true });
      writeFileSync(opts.PID_PATH, JSON.stringify(data));
      expect(await isDaemonRunning()).toBe(false);
    });
  });
});
