import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "./monitor-event";
import * as monitorEventModule from "./monitor-event";
import {
  CI_FINISHED,
  MONITOR_SEVERITIES,
  MONITOR_SEVERITY_RANK,
  PR_MERGE_STATE_CHANGED,
  PR_OPENED,
  PR_REVIEW_COMMENT_POSTED,
  QUOTA_UTILIZATION_THRESHOLD,
  SESSION_IDLE,
  SESSION_PERMISSION_REQUEST,
  enrichMonitorEvent,
  hasExplicitSeverity,
  severityForMonitorEvent,
  summarizeMonitorEvent,
} from "./monitor-event";
import {
  DAEMON_CONFIG_RELOADED,
  DAEMON_RESTARTED,
  GC_PRUNED,
  HEARTBEAT,
  METRIC_SESSION_COMMAND_HIST,
  METRIC_SESSION_FOOTPRINT,
  METRIC_SESSION_QUERIES,
  SESSION_SPAWN_OVERRIDE,
  SESSION_TOOL_USE,
  VFS_COMPLETED,
  VFS_FAILED,
  VFS_PROGRESS,
  WORKER_RATELIMITED,
  formatMonitorEvent,
} from "./monitor-event";

/** Every exported event-name constant, so new event types are covered automatically. */
const KNOWN_EVENTS: string[] = Object.values(monitorEventModule as Record<string, unknown>).filter(
  (v): v is string => typeof v === "string",
);

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

  test("session.spawn_override shows binary path without bypassed reason when none", () => {
    const line = formatMonitorEvent(
      event({
        event: SESSION_SPAWN_OVERRIDE,
        sessionId: "abcdef1234567890",
        binaryPath: "/custom/claude",
      }),
    );
    expect(line).toContain("session.spawn_override");
    expect(line).toContain("/custom/claude");
    expect(line).not.toContain("bypassed");
  });

  test("session.spawn_override shows binary path and bypassed reason", () => {
    const line = formatMonitorEvent(
      event({
        event: SESSION_SPAWN_OVERRIDE,
        sessionId: "abcdef1234567890",
        binaryPath: "/canary/claude",
        bypassedReason: "version gate: upgrade required",
      }),
    );
    expect(line).toContain("session.spawn_override");
    expect(line).toContain("/canary/claude");
    expect(line).toContain("bypassed: version gate: upgrade required");
  });

  test("vfs.progress shows the operation, target, phase and percent", () => {
    const line = formatMonitorEvent(
      event({
        event: VFS_PROGRESS,
        category: "vfs",
        operation: "clone",
        provider: "confluence",
        scope: "FOO",
        phase: "list",
        current: 250,
        total: 5000,
        percent: 5,
        unit: "pages",
      }),
    );
    expect(line).toContain("vfs.progress");
    expect(line).toContain("clone  confluence/FOO");
    expect(line).toContain("list");
    expect(line).toContain("250/5000 pages (5%)");
  });

  test("vfs.progress degrades to a bare counter without a total", () => {
    const line = formatMonitorEvent(
      event({
        event: VFS_PROGRESS,
        category: "vfs",
        operation: "pull",
        provider: "asana",
        scope: "123",
        phase: "list",
        current: 50,
        unit: "tasks",
      }),
    );
    expect(line).toContain("pull  asana/123");
    expect(line).toContain("50 tasks");
    expect(line).not.toContain("%");
  });

  test("vfs.completed shows the final count", () => {
    const line = formatMonitorEvent(
      event({
        event: VFS_COMPLETED,
        category: "vfs",
        operation: "clone",
        provider: "confluence",
        scope: "FOO",
        current: 5000,
        total: 5000,
        percent: 100,
        unit: "pages",
      }),
    );
    expect(line).toContain("vfs.completed");
    expect(line).toContain("5000/5000 pages (100%)");
  });

  test("vfs.failed reports the reason, so a subscriber can stop waiting", () => {
    const line = formatMonitorEvent(
      event({
        event: VFS_FAILED,
        category: "vfs",
        operation: "clone",
        provider: "confluence",
        scope: "FOO",
        current: 1200,
        total: 5000,
        percent: 24,
        unit: "pages",
        error: "401 token expired",
      }),
    );
    expect(line).toContain("vfs.failed");
    expect(line).toContain("clone  confluence/FOO");
    expect(line).toContain("1200/5000 pages (24%)");
    expect(line).toContain("401 token expired");
  });

  test("uses producer summary as the detail for unknown event types", () => {
    const line = formatMonitorEvent(event({ event: "future.event", summary: "something happened" }));
    expect(line).toContain("future.event");
    expect(line).toContain("something happened");
  });
});

describe("summarizeMonitorEvent", () => {
  test("renders the same detail the formatter uses", () => {
    const e = event({ event: PR_MERGE_STATE_CHANGED, prNumber: 42, from: "CLEAN", to: "BEHIND", cascadeHead: 41 });
    expect(summarizeMonitorEvent(e)).toBe("PR#42  CLEAN → BEHIND  cascade:#41");
  });

  test("works without seq/ts (emit time, before the bus stamps them)", () => {
    const summary = summarizeMonitorEvent({
      src: "test",
      category: "ci",
      event: CI_FINISHED,
      prNumber: 7,
      allGreen: true,
    });
    expect(summary).toContain("PR#7");
    expect(summary).toContain("all green");
  });

  test("falls back to the event name when there are no contextual fields", () => {
    expect(summarizeMonitorEvent({ src: "t", category: "session", event: "session.cleared" })).toBe("session.cleared");
  });

  test("collapses newlines and caps at 120 chars", () => {
    const summary = summarizeMonitorEvent(
      event({ event: "unknown.event", detail: `line1\n  line2${"x".repeat(400)}` }),
    );
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary).not.toContain("\n");
    expect(summary).toBe(summary.trimStart());
  });
});

describe("severityForMonitorEvent", () => {
  test("maps known tiers", () => {
    expect(severityForMonitorEvent(event({ event: SESSION_PERMISSION_REQUEST }))).toBe("urgent");
    expect(severityForMonitorEvent(event({ event: SESSION_IDLE }))).toBe("actionable");
    expect(severityForMonitorEvent(event({ event: PR_OPENED }))).toBe("notable");
    expect(severityForMonitorEvent(event({ event: HEARTBEAT }))).toBe("info");
  });

  test("defaults unmapped event types to info", () => {
    expect(severityForMonitorEvent(event({ event: "brand.new.event" }))).toBe("info");
  });

  test("pr.merge_state_changed is actionable only with a cascade head", () => {
    expect(severityForMonitorEvent(event({ event: PR_MERGE_STATE_CHANGED, from: "CLEAN", to: "DIRTY" }))).toBe(
      "notable",
    );
    expect(
      severityForMonitorEvent(event({ event: PR_MERGE_STATE_CHANGED, from: "CLEAN", to: "BEHIND", cascadeHead: 12 })),
    ).toBe("actionable");
  });

  test("quota threshold escalates to urgent at 95%", () => {
    expect(severityForMonitorEvent(event({ event: QUOTA_UTILIZATION_THRESHOLD, utilization: 80 }))).toBe("notable");
    expect(severityForMonitorEvent(event({ event: QUOTA_UTILIZATION_THRESHOLD, utilization: 95 }))).toBe("urgent");
  });

  test("review comments are actionable only when new ones landed", () => {
    expect(severityForMonitorEvent(event({ event: PR_REVIEW_COMMENT_POSTED, newCount: 0 }))).toBe("notable");
    expect(severityForMonitorEvent(event({ event: PR_REVIEW_COMMENT_POSTED, newCount: 3 }))).toBe("actionable");
  });

  test("ranks are ordered so consumers can threshold", () => {
    expect(MONITOR_SEVERITY_RANK.urgent).toBeGreaterThan(MONITOR_SEVERITY_RANK.actionable);
    expect(MONITOR_SEVERITY_RANK.actionable).toBeGreaterThan(MONITOR_SEVERITY_RANK.notable);
    expect(MONITOR_SEVERITY_RANK.notable).toBeGreaterThan(MONITOR_SEVERITY_RANK.info);
  });
});

describe("enrichMonitorEvent", () => {
  test("stamps a non-empty summary and a valid severity", () => {
    const e = enrichMonitorEvent({ src: "test", category: "session", event: SESSION_IDLE, sessionId: "abcdef1234" });
    expect(e.summary).toBeTruthy();
    expect(MONITOR_SEVERITIES).toContain(e.severity);
    expect(e.severity).toBe("actionable");
  });

  test("preserves producer-supplied summary and severity", () => {
    const e = enrichMonitorEvent({
      src: "test",
      category: "session",
      event: SESSION_IDLE,
      summary: "hand-written",
      severity: "urgent",
    });
    expect(e.summary).toBe("hand-written");
    expect(e.severity).toBe("urgent");
  });

  test("strips a nested payload that arrived over an untyped boundary", () => {
    // The type forbids `payload`, but IPC `extra` and automation `emit-event`
    // spread caller-supplied keys the compiler never sees. Feed one in.
    const hostile = {
      src: "test",
      category: "ci",
      event: CI_FINISHED,
      prNumber: 1,
      allGreen: false,
      payload: { state: "BEHIND" },
    } as unknown as Parameters<typeof enrichMonitorEvent>[0];
    const e = enrichMonitorEvent(hostile);
    expect(Object.hasOwn(e, "payload")).toBe(false);
    expect(JSON.stringify(e)).not.toContain("BEHIND");
  });

  test("rejects an out-of-set severity in favour of the table", () => {
    const hostile = {
      src: "test",
      category: "session",
      event: SESSION_PERMISSION_REQUEST,
      severity: "banana",
    } as unknown as Parameters<typeof enrichMonitorEvent>[0];
    const e = enrichMonitorEvent(hostile);
    expect(MONITOR_SEVERITIES).toContain(e.severity);
    expect(e.severity).toBe("urgent");
  });

  test("re-caps a producer-supplied summary that blows the budget", () => {
    const e = enrichMonitorEvent({
      src: "test",
      category: "session",
      event: SESSION_IDLE,
      summary: "z".repeat(500),
    });
    expect(e.summary.length).toBe(120);
    expect(e.summary.endsWith("…")).toBe(true);
  });

  test("degrades instead of throwing when rendering blows up", () => {
    // `fallback` stringifies arbitrary producer values; a throwing toString is
    // the cheapest realistic way to make rendering fail. Delivery must survive,
    // and the static tier must be preserved.
    const poison = {
      src: "test",
      category: "session",
      event: SESSION_PERMISSION_REQUEST,
      bad: {
        toString() {
          throw new Error("boom");
        },
      },
    } as unknown as Parameters<typeof enrichMonitorEvent>[0];
    const e = enrichMonitorEvent(poison);
    expect(e.summary).toBe(SESSION_PERMISSION_REQUEST);
    expect(e.severity).toBe("urgent");
  });

  test("every exported event-name constant has an explicit severity classification", () => {
    // Not a tautology: `severityForMonitorEvent` defaults to `info`, so a new
    // event constant with no table entry would otherwise sit silently below the
    // documented actionability filter. This fails until the table is updated.
    for (const name of KNOWN_EVENTS) {
      expect(hasExplicitSeverity(name), `no explicit severity tier for "${name}"`).toBe(true);
    }
  });

  test("every known event type produces a non-empty summary and a valid severity", () => {
    for (const name of KNOWN_EVENTS) {
      const e = enrichMonitorEvent({ src: "test", category: "session", event: name });
      expect(e.summary, `summary for ${name}`).toBeTruthy();
      expect(MONITOR_SEVERITIES, `severity for ${name}`).toContain(e.severity);
    }
  });
});
