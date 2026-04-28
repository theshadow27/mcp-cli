import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "./monitor-event";
import {
  DAEMON_CONFIG_RELOADED,
  DAEMON_RESTARTED,
  GC_PRUNED,
  WORKER_RATELIMITED,
  formatMonitorEvent,
} from "./monitor-event";

function makeEvent(overrides: Partial<MonitorEvent> & { event: string }): MonitorEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    src: "test",
    category: "daemon",
    ...overrides,
  };
}

describe("formatMonitorEvent — lifecycle events", () => {
  test("worker.ratelimited includes provider and retry", () => {
    const line = formatMonitorEvent(
      makeEvent({
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
      makeEvent({
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
      makeEvent({
        event: DAEMON_RESTARTED,
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
      makeEvent({
        seq: 5,
        event: DAEMON_RESTARTED,
        reason: "start",
        seqBefore: 4,
      }),
    );
    expect(line).toContain("seq:4");
    expect(line).toContain("→5");
  });

  test("daemon.config_reloaded shows changed keys", () => {
    const line = formatMonitorEvent(
      makeEvent({
        event: DAEMON_CONFIG_RELOADED,
        changedKeys: ["server-a", "server-b"],
      }),
    );
    expect(line).toContain("daemon.config_reloaded");
    expect(line).toContain("server-a, server-b");
  });

  test("daemon.config_reloaded with path shows truncated path", () => {
    const line = formatMonitorEvent(
      makeEvent({
        event: DAEMON_CONFIG_RELOADED,
        path: "/home/user/.mcp-cli/servers.json",
        changedKeys: ["x"],
      }),
    );
    expect(line).toContain("daemon.config_reloaded");
    expect(line).toContain("servers.json");
  });

  test("gc.pruned shows worktree and branch counts", () => {
    const line = formatMonitorEvent(
      makeEvent({
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
      makeEvent({
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
