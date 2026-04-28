import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "./monitor-event";
import {
  HEARTBEAT,
  METRIC_SESSION_COMMAND_HIST,
  METRIC_SESSION_FOOTPRINT,
  METRIC_SESSION_QUERIES,
  SESSION_TOOL_USE,
  formatMonitorEvent,
} from "./monitor-event";

function event(overrides: Partial<MonitorEvent> & { event: string }): MonitorEvent {
  return {
    seq: 1,
    ts: "2025-01-01T12:00:00.000Z",
    src: "test",
    category: "session",
    ...overrides,
  };
}

describe("formatMonitorEvent", () => {
  test("formats session.tool_use with tool name and file path", () => {
    const line = formatMonitorEvent(
      event({
        event: SESSION_TOOL_USE,
        sessionId: "abcdef1234567890",
        toolName: "Read",
        filePath: "/src/foo.ts",
      }),
    );
    expect(line).toContain("session.tool_use");
    expect(line).toContain("abcdef12");
    expect(line).toContain("Read");
    expect(line).toContain("/src/foo.ts");
  });

  test("formats metric.session.footprint with dir count and ratio", () => {
    const line = formatMonitorEvent(
      event({
        event: METRIC_SESSION_FOOTPRINT,
        sessionId: "abcdef1234567890",
        footprint: [
          { dir: "/src", read: 100, wrote: 50, files: 3 },
          { dir: "/test", read: 200, wrote: 0, files: 2 },
        ],
        readWriteRatio: 6,
      }),
    );
    expect(line).toContain("metric.session.footprint");
    expect(line).toContain("2 dir(s)");
    expect(line).toContain("rw:6");
  });

  test("formats metric.session.command_hist with command count", () => {
    const line = formatMonitorEvent(
      event({
        event: METRIC_SESSION_COMMAND_HIST,
        sessionId: "abcdef1234567890",
        commands: [{ cmd: "bun test", runs: 3 }],
      }),
    );
    expect(line).toContain("metric.session.command_hist");
    expect(line).toContain("1 command(s)");
  });

  test("formats metric.session.queries with query count", () => {
    const line = formatMonitorEvent(
      event({
        event: METRIC_SESSION_QUERIES,
        sessionId: "abcdef1234567890",
        recent: [
          { tool: "Grep", pattern: "foo" },
          { tool: "Glob", pattern: "*.ts" },
        ],
      }),
    );
    expect(line).toContain("metric.session.queries");
    expect(line).toContain("2 recent query(ies)");
  });

  test("formats heartbeat", () => {
    const line = formatMonitorEvent(event({ event: HEARTBEAT, category: "heartbeat", seq: 42 }));
    expect(line).toContain("heartbeat");
    expect(line).toContain("seq:42");
  });

  test("falls back for unknown event types", () => {
    const line = formatMonitorEvent(event({ event: "custom.unknown", sessionId: "s1", extra: "data" }));
    expect(line).toContain("custom.unknown");
    expect(line).toContain("sessionId:");
  });

  test("caps output at 200 characters", () => {
    const line = formatMonitorEvent(
      event({
        event: SESSION_TOOL_USE,
        sessionId: "abcdef1234567890",
        toolName: "Read",
        filePath: "/very/long/path".repeat(20),
      }),
    );
    expect(line.length).toBeLessThanOrEqual(200);
  });
});
