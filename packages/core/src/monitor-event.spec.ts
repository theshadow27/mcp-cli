import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "./monitor-event";
import {
  DAEMON_CONFIG_RELOADED,
  DAEMON_RESTARTED,
  GC_PRUNED,
  HEARTBEAT,
  METRIC_SESSION_COMMAND_HIST,
  METRIC_SESSION_FOOTPRINT,
  METRIC_SESSION_QUERIES,
  SESSION_TOOL_USE,
  WORKER_RATELIMITED,
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

describe("formatMonitorEvent — lifecycle events", () => {
  test("worker.ratelimited includes provider and retry", () => {
    const line = formatMonitorEvent(
      event({
        event: WORKER_RATELIMITED,
        category: "worker",
        sessionId: "sess-abc123",
        provider: "anthropic",
        retryAfterMs: 30000,
      }),
    );
    expect(line).toContain("worker.ratelimited");
    expect(line).toContain("anthropic");
    expect(line).toContain("retry in 30s");
    expect(line).toContain("sess-abc");
  });

  test("worker.ratelimited without retryAfterMs omits retry", () => {
    const line = formatMonitorEvent(
      event({
        event: WORKER_RATELIMITED,
        category: "worker",
        sessionId: "sess-x",
        provider: "anthropic",
      }),
    );
    expect(line).toContain("anthropic");
    expect(line).not.toContain("retry in");
  });

  test("daemon.restarted shows reason and seq range", () => {
    const line = formatMonitorEvent(
      event({
        event: DAEMON_RESTARTED,
        category: "daemon",
        reason: "start",
        seqBefore: 42,
        seqAfter: 43,
      }),
    );
    expect(line).toContain("daemon.restarted");
    expect(line).toContain("start");
    expect(line).toContain("seq:42");
    expect(line).toContain("→43");
  });

  test("daemon.restarted falls back to seq when seqAfter absent", () => {
    const line = formatMonitorEvent(
      event({
        seq: 5,
        event: DAEMON_RESTARTED,
        category: "daemon",
        reason: "start",
        seqBefore: 4,
      }),
    );
    expect(line).toContain("seq:4");
    expect(line).toContain("→5");
  });

  test("daemon.config_reloaded shows changed keys", () => {
    const line = formatMonitorEvent(
      event({
        event: DAEMON_CONFIG_RELOADED,
        category: "daemon",
        changedKeys: ["server-a", "server-b"],
      }),
    );
    expect(line).toContain("daemon.config_reloaded");
    expect(line).toContain("server-a, server-b");
  });

  test("daemon.config_reloaded with path shows truncated path", () => {
    const line = formatMonitorEvent(
      event({
        event: DAEMON_CONFIG_RELOADED,
        category: "daemon",
        path: "/home/user/.mcp-cli/servers.json",
        changedKeys: ["x"],
      }),
    );
    expect(line).toContain("daemon.config_reloaded");
    expect(line).toContain("servers.json");
  });

  test("gc.pruned shows worktree and branch counts", () => {
    const line = formatMonitorEvent(
      event({
        event: GC_PRUNED,
        category: "gc",
        worktrees: ["wt-a", "wt-b"],
        branches: ["br-1"],
        reason: "manual",
      }),
    );
    expect(line).toContain("gc.pruned");
    expect(line).toContain("2wt");
    expect(line).toContain("1br");
    expect(line).toContain("manual");
  });

  test("gc.pruned with empty arrays shows 0 counts", () => {
    const line = formatMonitorEvent(
      event({
        event: GC_PRUNED,
        category: "gc",
        worktrees: [],
        branches: [],
      }),
    );
    expect(line).toContain("0wt");
    expect(line).toContain("0br");
  });
});
