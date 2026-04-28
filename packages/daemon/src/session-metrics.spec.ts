import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import {
  METRIC_SESSION_COMMAND_HIST,
  METRIC_SESSION_FOOTPRINT,
  METRIC_SESSION_QUERIES,
  SESSION_DISCONNECTED,
  SESSION_ENDED,
  SESSION_IDLE,
  SESSION_TOOL_USE,
} from "@mcp-cli/core";
import { EventBus } from "./event-bus";
import { SessionMetricsAggregator, createFreshState, deserializeState, serializeState } from "./session-metrics";

function defined<T>(value: T | undefined | null, label = "value"): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metrics (
      session_id TEXT PRIMARY KEY,
      metrics_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return db;
}

function toolUse(sessionId: string, toolName: string, extra: Record<string, unknown> = {}): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_TOOL_USE,
    category: "session",
    sessionId,
    toolName,
    ...extra,
  };
}

function sessionEnd(sessionId: string): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_ENDED,
    category: "session",
    sessionId,
  };
}

function sessionIdle(sessionId: string): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_IDLE,
    category: "session",
    sessionId,
  };
}

describe("SessionMetricsAggregator", () => {
  let db: Database;
  let bus: EventBus;
  let agg: SessionMetricsAggregator;
  let received: MonitorEvent[];

  beforeEach(() => {
    db = freshDb();
    bus = new EventBus();
    received = [];
    agg = new SessionMetricsAggregator({ bus, db, coalesceWindowMs: 500 });
    bus.subscribe((e) => received.push(e));
  });

  afterEach(() => {
    agg.dispose();
    db.close();
  });

  describe("directory footprint", () => {
    test("accumulates read lines by directory", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/bar.ts",
          dirPath: "/src",
          linesHint: 200,
        }),
      );

      const state = defined(agg.getState("s1"));
      const dir = defined(state.dirFootprint.get("/src"));
      expect(dir.read).toBe(300);
      expect(dir.wrote).toBe(0);
    });

    test("accumulates write lines by directory", () => {
      bus.publish(
        toolUse("s1", "Write", {
          filePath: "/src/new.ts",
          dirPath: "/src",
          linesHint: 50,
          isWrite: true,
        }),
      );

      const state = defined(agg.getState("s1"));
      const dir = defined(state.dirFootprint.get("/src"));
      expect(dir.read).toBe(0);
      expect(dir.wrote).toBe(50);
    });

    test("counts unique files per directory", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/bar.ts",
          dirPath: "/src",
          linesHint: 50,
        }),
      );

      const state = defined(agg.getState("s1"));
      const dir = defined(state.dirFootprint.get("/src"));
      expect(dir.fileSet.size).toBe(2);
    });

    test("emits coalesced footprint event", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );

      bus.flushCoalesced("metric:s1:footprint");

      const footprintEvents = received.filter((e) => e.event === METRIC_SESSION_FOOTPRINT);
      expect(footprintEvents).toHaveLength(1);
      const fp = footprintEvents[0];
      expect(fp.sessionId).toBe("s1");
      expect(fp.footprint).toEqual([{ dir: "/src", read: 100, wrote: 0, files: 1 }]);
      expect(fp.readWriteRatio).toBeNull();
    });

    test("computes readWriteRatio when writes exist", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 200,
        }),
      );
      bus.publish(
        toolUse("s1", "Write", {
          filePath: "/src/out.ts",
          dirPath: "/src",
          linesHint: 100,
          isWrite: true,
        }),
      );

      bus.flushCoalesced("metric:s1:footprint");

      const fp = defined(received.find((e) => e.event === METRIC_SESSION_FOOTPRINT));
      expect(fp.readWriteRatio).toBe(2);
    });
  });

  describe("command history", () => {
    test("groups Bash commands by cmdGroup", () => {
      bus.publish(toolUse("s1", "Bash", { cmdGroup: "bun test", command: "bun test --bail" }));
      bus.publish(toolUse("s1", "Bash", { cmdGroup: "bun test", command: "bun test" }));
      bus.publish(toolUse("s1", "Bash", { cmdGroup: "git status", command: "git status" }));

      const state = defined(agg.getState("s1"));
      expect(state.commandHist.get("bun test")).toBe(2);
      expect(state.commandHist.get("git status")).toBe(1);
    });

    test("emits coalesced command_hist event", () => {
      bus.publish(toolUse("s1", "Bash", { cmdGroup: "bun test", command: "bun test" }));

      bus.flushCoalesced("metric:s1:commands");

      const cmdEvents = received.filter((e) => e.event === METRIC_SESSION_COMMAND_HIST);
      expect(cmdEvents).toHaveLength(1);
      expect(cmdEvents[0].commands).toEqual([{ cmd: "bun test", runs: 1 }]);
    });
  });

  describe("recent queries ring buffer", () => {
    test("stores Grep queries", () => {
      bus.publish(toolUse("s1", "Grep", { pattern: "foo", searchPath: "/src" }));

      const state = defined(agg.getState("s1"));
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0]).toEqual({
        tool: "Grep",
        pattern: "foo",
        path: "/src",
      });
    });

    test("stores Glob queries", () => {
      bus.publish(toolUse("s1", "Glob", { pattern: "**/*.ts", searchPath: "/src" }));

      const state = defined(agg.getState("s1"));
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0].tool).toBe("Glob");
    });

    test("evicts oldest entries when exceeding max", () => {
      const agg2 = new SessionMetricsAggregator({
        bus,
        db,
        maxQueries: 3,
        coalesceWindowMs: 500,
      });

      for (let i = 0; i < 5; i++) {
        bus.publish(toolUse("s2", "Grep", { pattern: `p${i}`, searchPath: "/src" }));
      }

      const state = defined(agg2.getState("s2"));
      expect(state.queries).toHaveLength(3);
      expect(state.queries[0].pattern).toBe("p2");
      expect(state.queries[2].pattern).toBe("p4");

      agg2.dispose();
    });

    test("emits coalesced queries event", () => {
      bus.publish(toolUse("s1", "Grep", { pattern: "foo", searchPath: "/src" }));

      bus.flushCoalesced("metric:s1:queries");

      const qEvents = received.filter((e) => e.event === METRIC_SESSION_QUERIES);
      expect(qEvents).toHaveLength(1);
      expect((qEvents[0].recent as unknown[]).length).toBe(1);
    });
  });

  describe("read depth", () => {
    test("tracks read count per file", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 50,
        }),
      );

      const state = defined(agg.getState("s1"));
      const rd = defined(state.readDepth.get("/src/foo.ts"));
      expect(rd.readCount).toBe(2);
      expect(rd.linesReadTotal).toBe(150);
    });

    test("tracks max lines per file", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 2000,
        }),
      );

      const state = defined(agg.getState("s1"));
      const rd = defined(state.readDepth.get("/src/foo.ts"));
      expect(rd.maxLines).toBe(2000);
    });

    test("does not count writes in read depth", () => {
      bus.publish(
        toolUse("s1", "Write", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
          isWrite: true,
        }),
      );

      const state = defined(agg.getState("s1"));
      expect(state.readDepth.has("/src/foo.ts")).toBe(false);
    });
  });

  describe("state timing", () => {
    test("transitions to active on tool_use", () => {
      bus.publish(toolUse("s1", "Read", { filePath: "/f", dirPath: "/", linesHint: 1 }));

      const state = defined(agg.getState("s1"));
      expect(state.currentState.state).toBe("active");
    });

    test("transitions to idle on session.idle", () => {
      bus.publish(toolUse("s1", "Read", { filePath: "/f", dirPath: "/", linesHint: 1 }));
      bus.publish(sessionIdle("s1"));

      const state = defined(agg.getState("s1"));
      expect(state.currentState.state).toBe("idle");
    });
  });

  describe("session lifecycle", () => {
    test("cleans up memory on session.ended", () => {
      bus.publish(toolUse("s1", "Read", { filePath: "/f", dirPath: "/", linesHint: 1 }));
      expect(agg.sessionCount).toBe(1);

      bus.publish(sessionEnd("s1"));
      expect(agg.sessionCount).toBe(0);
    });

    test("cleans up on session.disconnected", () => {
      bus.publish(toolUse("s1", "Read", { filePath: "/f", dirPath: "/", linesHint: 1 }));

      bus.publish({
        src: "daemon.claude-server",
        event: SESSION_DISCONNECTED,
        category: "session",
        sessionId: "s1",
      });

      expect(agg.sessionCount).toBe(0);
    });

    test("persists metrics to DB on session end", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(sessionEnd("s1"));

      const row = db
        .query<{ metrics_json: string }, [string]>("SELECT metrics_json FROM session_metrics WHERE session_id = ?")
        .get("s1");

      const validRow = defined(row);
      const parsed = JSON.parse(validRow.metrics_json);
      expect(parsed.dirFootprint).toHaveLength(1);
      expect(parsed.dirFootprint[0].dir).toBe("/src");
      expect(parsed.hasToolCalls).toBe(true);
    });

    test("does not persist sessions with no tool calls", () => {
      bus.publish(sessionEnd("s1"));

      const row = db
        .query<{ metrics_json: string }, [string]>("SELECT metrics_json FROM session_metrics WHERE session_id = ?")
        .get("s1");

      expect(row).toBeNull();
    });

    test("loads persisted state on reconnect", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(toolUse("s1", "Bash", { cmdGroup: "bun test", command: "bun test" }));
      bus.publish(sessionEnd("s1"));
      expect(agg.sessionCount).toBe(0);

      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/bar.ts",
          dirPath: "/src",
          linesHint: 50,
        }),
      );

      const state = defined(agg.getState("s1"));
      expect(defined(state.dirFootprint.get("/src")).read).toBe(150);
      expect(state.commandHist.get("bun test")).toBe(1);
    });

    test("flushes metric events on session end", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/src/foo.ts",
          dirPath: "/src",
          linesHint: 100,
        }),
      );
      bus.publish(sessionEnd("s1"));

      const footprintEvents = received.filter((e) => e.event === METRIC_SESSION_FOOTPRINT);
      expect(footprintEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("multi-session isolation", () => {
    test("sessions do not share state", () => {
      bus.publish(
        toolUse("s1", "Read", {
          filePath: "/a/foo.ts",
          dirPath: "/a",
          linesHint: 100,
        }),
      );
      bus.publish(
        toolUse("s2", "Read", {
          filePath: "/b/bar.ts",
          dirPath: "/b",
          linesHint: 200,
        }),
      );

      const s1 = defined(agg.getState("s1"));
      const s2 = defined(agg.getState("s2"));
      expect(s1.dirFootprint.has("/a")).toBe(true);
      expect(s1.dirFootprint.has("/b")).toBe(false);
      expect(s2.dirFootprint.has("/b")).toBe(true);
      expect(s2.dirFootprint.has("/a")).toBe(false);
    });
  });

  describe("dispose", () => {
    test("persists all active sessions to DB", () => {
      bus.publish(toolUse("s1", "Read", { filePath: "/f", dirPath: "/", linesHint: 1 }));
      bus.publish(toolUse("s2", "Read", { filePath: "/g", dirPath: "/", linesHint: 1 }));

      agg.dispose();

      const rows = db.query<{ session_id: string }, []>("SELECT session_id FROM session_metrics").all();
      expect(rows).toHaveLength(2);
    });
  });
});

describe("serializeState / deserializeState", () => {
  test("round-trips a full state", () => {
    const state = createFreshState("s1");
    state.hasToolCalls = true;
    state.dirFootprint.set("/src", {
      read: 100,
      wrote: 50,
      fileSet: new Set(["/src/a.ts", "/src/b.ts"]),
    });
    state.commandHist.set("bun test", 3);
    state.queries.push({ tool: "Grep", pattern: "foo", path: "/src" });
    state.readDepth.set("/src/a.ts", {
      readCount: 2,
      linesReadTotal: 200,
      maxLines: 150,
    });
    state.stateAccum.set("active", 5000);
    state.stateAccum.set("idle", 2000);

    const json = serializeState(state);
    const restored = deserializeState("s1", JSON.parse(json));

    expect(restored.hasToolCalls).toBe(true);
    const srcDir = defined(restored.dirFootprint.get("/src"));
    expect(srcDir.read).toBe(100);
    expect(srcDir.wrote).toBe(50);
    expect(srcDir.fileSet.size).toBe(2);
    expect(restored.commandHist.get("bun test")).toBe(3);
    expect(restored.queries).toHaveLength(1);
    expect(defined(restored.readDepth.get("/src/a.ts")).readCount).toBe(2);
    expect(restored.stateAccum.get("active")).toBe(5000);
    expect(restored.stateAccum.get("idle")).toBe(2000);
  });

  test("handles empty state", () => {
    const state = createFreshState("s1");
    const json = serializeState(state);
    const restored = deserializeState("s1", JSON.parse(json));

    expect(restored.dirFootprint.size).toBe(0);
    expect(restored.commandHist.size).toBe(0);
    expect(restored.queries).toHaveLength(0);
    expect(restored.readDepth.size).toBe(0);
  });
});

describe("extractToolFields", () => {
  let extractToolFields: (toolName: string, input: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    const mod = await import("./claude-session/ws-server");
    extractToolFields = mod.extractToolFields;
  });

  test("Read extracts filePath, dirPath, linesHint", () => {
    const fields = extractToolFields("Read", {
      file_path: "/src/foo.ts",
      limit: 50,
    });
    expect(fields.filePath).toBe("/src/foo.ts");
    expect(fields.dirPath).toBe("/src");
    expect(fields.linesHint).toBe(50);
    expect(fields.isWrite).toBeUndefined();
  });

  test("Read defaults linesHint to 2000", () => {
    const fields = extractToolFields("Read", { file_path: "/src/foo.ts" });
    expect(fields.linesHint).toBe(2000);
  });

  test("Write marks isWrite and counts lines", () => {
    const fields = extractToolFields("Write", {
      file_path: "/src/out.ts",
      content: "line1\nline2\nline3",
    });
    expect(fields.filePath).toBe("/src/out.ts");
    expect(fields.isWrite).toBe(true);
    expect(fields.linesHint).toBe(3);
  });

  test("Edit marks isWrite and counts new_string lines", () => {
    const fields = extractToolFields("Edit", {
      file_path: "/src/foo.ts",
      new_string: "a\nb",
    });
    expect(fields.isWrite).toBe(true);
    expect(fields.linesHint).toBe(2);
  });

  test("Bash extracts command and cmdGroup", () => {
    const fields = extractToolFields("Bash", {
      command: "bun test --bail",
    });
    expect(fields.command).toBe("bun test --bail");
    expect(fields.cmdGroup).toBe("bun test");
  });

  test("Bash handles single-token commands", () => {
    const fields = extractToolFields("Bash", { command: "ls" });
    expect(fields.cmdGroup).toBe("ls");
  });

  test("Grep extracts pattern and searchPath", () => {
    const fields = extractToolFields("Grep", {
      pattern: "foo.*bar",
      path: "/src",
    });
    expect(fields.pattern).toBe("foo.*bar");
    expect(fields.searchPath).toBe("/src");
  });

  test("Glob extracts pattern and searchPath", () => {
    const fields = extractToolFields("Glob", {
      pattern: "**/*.ts",
      path: "/src",
    });
    expect(fields.pattern).toBe("**/*.ts");
    expect(fields.searchPath).toBe("/src");
  });

  test("NotebookEdit marks isWrite", () => {
    const fields = extractToolFields("NotebookEdit", {
      file_path: "/src/nb.ipynb",
    });
    expect(fields.filePath).toBe("/src/nb.ipynb");
    expect(fields.isWrite).toBe(true);
  });

  test("unknown tool returns empty fields", () => {
    const fields = extractToolFields("CustomTool", { data: "value" });
    expect(Object.keys(fields)).toHaveLength(0);
  });
});
