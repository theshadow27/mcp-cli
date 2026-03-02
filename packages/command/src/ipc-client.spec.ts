import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PID_MAX_AGE_MS, PID_PATH, SOCKET_PATH } from "@mcp-cli/core";
import { isDaemonRunning, isProcessMcpd } from "./ipc-client.js";

describe("PID staleness detection", () => {
  let savedPid: string | null = null;

  beforeEach(() => {
    // Preserve any existing PID file
    try {
      savedPid = readFileSync(PID_PATH, "utf-8");
    } catch {
      savedPid = null;
    }
  });

  afterEach(() => {
    // Restore original PID file state
    if (savedPid !== null) {
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, savedPid);
    } else {
      try {
        unlinkSync(PID_PATH);
      } catch {
        /* already gone */
      }
    }
  });

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
      try {
        unlinkSync(PID_PATH);
      } catch {
        /* already gone */
      }
      expect(await isDaemonRunning()).toBe(false);
    });

    test("returns false and cleans up for invalid JSON in PID file", async () => {
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, "not valid json{{{");
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(PID_PATH)).toBe(false);
    });

    test("returns false and cleans up for PID file older than max age", async () => {
      const staleData = {
        pid: process.pid,
        configHash: "abc123",
        startedAt: Date.now() - PID_MAX_AGE_MS - 1000,
      };
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, JSON.stringify(staleData));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(PID_PATH)).toBe(false);
    });

    test("returns false and cleans up for missing startedAt field", async () => {
      const badData = { pid: process.pid, configHash: "abc123" };
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, JSON.stringify(badData));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(PID_PATH)).toBe(false);
    });

    test("returns false and cleans up when process does not exist", async () => {
      const data = {
        pid: 4294967, // very unlikely to be a real process
        configHash: "abc123",
        startedAt: Date.now(),
      };
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, JSON.stringify(data));
      expect(await isDaemonRunning()).toBe(false);
      expect(existsSync(PID_PATH)).toBe(false);
    });

    test("returns false when PID belongs to a non-mcpd process", async () => {
      // Current process is bun (test runner), not mcpd
      const data = {
        pid: process.pid,
        configHash: "abc123",
        startedAt: Date.now(),
      };
      mkdirSync(dirname(PID_PATH), { recursive: true });
      writeFileSync(PID_PATH, JSON.stringify(data));
      expect(await isDaemonRunning()).toBe(false);
    });
  });
});
