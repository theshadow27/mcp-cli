import { describe, expect, test } from "bun:test";
import { getDaemonLogLines, installDaemonLogCapture } from "./daemon-log.js";

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
