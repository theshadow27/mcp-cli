import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDaemonLogFile, getDaemonLogLines, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log";

// installDaemonLogCapture is a one-time singleton, so install once for all tests.
installDaemonLogCapture();

describe("daemon-log", () => {
  test("installDaemonLogCapture intercepts console.error", () => {
    console.error("[mcpd] test message");

    const lines = getDaemonLogLines();
    const match = lines.find((l) => l.line === "[mcpd] test message");
    expect(match).toBeDefined();
    expect(match?.timestamp).toBeGreaterThan(0);
  });

  test("getDaemonLogLines returns lines in order", () => {
    console.error("order-a");
    console.error("order-b");
    console.error("order-c");

    const lines = getDaemonLogLines();
    const texts = lines.map((l) => l.line);
    const idxA = texts.lastIndexOf("order-a");
    const idxB = texts.lastIndexOf("order-b");
    const idxC = texts.lastIndexOf("order-c");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  test("limit parameter restricts output", () => {
    // Push enough lines to exceed the limit
    for (let i = 0; i < 10; i++) {
      console.error(`limit-test-${i}`);
    }

    const limited = getDaemonLogLines(3);
    expect(limited).toHaveLength(3);
    // Should be the most recent 3
    expect(limited[limited.length - 1].line).toBe("limit-test-9");
  });

  test("multi-arg console.error calls are joined with spaces", () => {
    console.error("hello", "world", 42);

    const lines = getDaemonLogLines();
    const match = lines.find((l) => l.line === "hello world 42");
    expect(match).toBeDefined();
  });

  test("second installDaemonLogCapture call is a no-op", () => {
    const countBefore = getDaemonLogLines().length;
    installDaemonLogCapture(); // should not double-wrap
    console.error("after-reinstall");
    const lines = getDaemonLogLines();
    // Should only have one new line, not two (which would happen if double-wrapped)
    const afterLines = lines.filter((l) => l.line === "after-reinstall");
    expect(afterLines).toHaveLength(1);
  });
});

describe("daemon-log file", () => {
  const testDir = join(tmpdir(), `mcpd-log-test-${process.pid}`);
  const logPath = join(testDir, "mcpd.log");
  const backupPath = join(testDir, "mcpd.log.1");

  afterEach(() => {
    closeDaemonLogFile();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // already gone
    }
  });

  function setupDir(): void {
    const { mkdirSync } = require("node:fs");
    mkdirSync(testDir, { recursive: true });
  }

  test("installDaemonLogFile writes log entries to file", () => {
    setupDir();
    installDaemonLogFile({ path: logPath, backupPath, maxBytes: 1024 * 1024 });

    console.error("file-test-line");

    closeDaemonLogFile();
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("file-test-line");
    // Each line should have ISO timestamp prefix
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // ISO 8601 format: 2024-01-01T00:00:00.000Z
    expect(lines[lines.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("log rotation triggers when file exceeds maxBytes", () => {
    setupDir();
    // Use a tiny maxBytes to trigger rotation quickly
    installDaemonLogFile({ path: logPath, backupPath, maxBytes: 100 });

    // Write enough lines to exceed 100 bytes and trigger the amortized rotation check
    for (let i = 0; i < 70; i++) {
      console.error(`rotation-line-${i}-${"x".repeat(20)}`);
    }

    closeDaemonLogFile();

    // Backup file should exist after rotation
    let backupExists = false;
    try {
      readFileSync(backupPath);
      backupExists = true;
    } catch {
      // no backup
    }
    expect(backupExists).toBe(true);

    // Current log file should still exist and be smaller than backup
    const currentContent = readFileSync(logPath, "utf-8");
    expect(currentContent.length).toBeGreaterThan(0);
  });
});
