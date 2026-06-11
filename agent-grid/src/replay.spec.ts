import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordingEntry } from "@mcp-cli/core";
import { parseRecording, replayThroughMock, validateRecording } from "./replay";

setDefaultTimeout(15_000);

const tmpFiles: string[] = [];
function tmpFile(suffix: string): string {
  const path = join(tmpdir(), `replay-test-${process.pid}-${Date.now()}-${suffix}`);
  tmpFiles.push(path);
  return path;
}
afterAll(() => {
  for (const f of tmpFiles) {
    try {
      rmSync(f, { recursive: true });
    } catch {}
  }
});

function entry(partial: Partial<RecordingEntry> & Pick<RecordingEntry, "dir" | "kind" | "payload">): RecordingEntry {
  return { t: Date.now(), ...partial };
}

const INIT: RecordingEntry = entry({
  dir: "daemon->worker",
  kind: "control",
  payload: { type: "init", daemonId: "test", protocol_version: 1 },
});
const READY: RecordingEntry = entry({
  dir: "worker->daemon",
  kind: "control",
  payload: { type: "ready", supported_protocol_version: 1 },
});
const ERROR_MSG: RecordingEntry = entry({
  dir: "worker->daemon",
  kind: "control",
  payload: { type: "error", message: "boom" },
});

function mcp(dir: RecordingEntry["dir"], payload: Record<string, unknown>): RecordingEntry {
  return entry({ dir, kind: "mcp", payload: { jsonrpc: "2.0", ...payload } });
}

function db(type: string, fields: Record<string, unknown> = {}): RecordingEntry {
  return entry({ dir: "worker->daemon", kind: "db", payload: { type, ...fields } });
}

// ── Static validation ─────────────────────────────────────────────

describe("validateRecording", () => {
  test("valid minimal handshake passes", () => {
    const report = validateRecording([INIT, READY], "test.ndjson");
    expect(report.pass).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.entries).toBe(2);
  });

  test("valid full exchange passes", () => {
    const entries: RecordingEntry[] = [
      INIT,
      READY,
      mcp("daemon->worker", { id: 1, method: "tools/list" }),
      mcp("worker->daemon", { id: 1, result: { tools: [] } }),
      db("db:upsert", { session: { sessionId: "s1", state: "connecting" } }),
      db("db:state", { sessionId: "s1", state: "active" }),
      db("db:upsert", { session: { sessionId: "s1", state: "init", model: "mock", cwd: "/tmp" } }),
      db("db:cost", { sessionId: "s1", cost: 0.01, tokens: 100 }),
      db("db:state", { sessionId: "s1", state: "idle" }),
      db("db:end", { sessionId: "s1" }),
    ];
    const report = validateRecording(entries, "test.ndjson");
    expect(report.pass).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  test("empty recording passes", () => {
    const report = validateRecording([], "empty.ndjson");
    expect(report.pass).toBe(true);
  });

  test("init with error handshake, no further messages, passes", () => {
    const report = validateRecording([INIT, ERROR_MSG], "err.ndjson");
    expect(report.pass).toBe(true);
  });

  test("missing init fails", () => {
    const report = validateRecording([READY], "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "handshake")).toBe(true);
  });

  test("missing ready/error after init fails", () => {
    const entries = [INIT, mcp("daemon->worker", { id: 1, method: "tools/list" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    const handshakeViolations = report.violations.filter((v) => v.rule === "handshake");
    expect(handshakeViolations.length).toBeGreaterThan(0);
  });

  test("MCP before ready fails", () => {
    const entries = [mcp("daemon->worker", { id: 1, method: "tools/list" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "handshake" && v.message.includes("MCP"))).toBe(true);
  });

  test("messages after error handshake fail", () => {
    const entries = [INIT, ERROR_MSG, mcp("daemon->worker", { id: 1, method: "tools/list" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "post-error")).toBe(true);
  });

  test("kind mismatch detected", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "daemon->worker", kind: "control", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "kind-mismatch")).toBe(true);
  });

  test("wrong direction for init detected", () => {
    const entries = [entry({ dir: "worker->daemon", kind: "control", payload: { type: "init" } }), READY];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "direction" && v.message.includes("init"))).toBe(true);
  });

  test("wrong direction for ready detected", () => {
    const entries = [INIT, entry({ dir: "daemon->worker", kind: "control", payload: { type: "ready" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "direction" && v.message.includes("ready"))).toBe(true);
  });

  test("DB event with wrong direction detected", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "daemon->worker", kind: "db", payload: { type: "db:end", sessionId: "s1" } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "direction" && v.message.includes("DB"))).toBe(true);
  });

  test("invalid timestamp detected", () => {
    const entries = [
      { t: -1, dir: "daemon->worker" as const, kind: "control" as const, payload: { type: "init" } },
      READY,
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "timestamp")).toBe(true);
  });

  test("missing required fields: error.message", () => {
    const entries = [INIT, entry({ dir: "worker->daemon", kind: "control", payload: { type: "error" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("message"))).toBe(true);
  });

  test("missing required fields: db:state", () => {
    const entries = [INIT, READY, db("db:state", {})];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    const rf = report.violations.filter((v) => v.rule === "required-field");
    expect(rf.some((v) => v.message.includes("sessionId"))).toBe(true);
    expect(rf.some((v) => v.message.includes("state"))).toBe(true);
  });

  test("missing required fields: db:cost", () => {
    const entries = [INIT, READY, db("db:cost", { sessionId: "s1" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    const rf = report.violations.filter((v) => v.rule === "required-field");
    expect(rf.some((v) => v.message.includes("cost"))).toBe(true);
    expect(rf.some((v) => v.message.includes("tokens"))).toBe(true);
  });

  test("missing required fields: db:upsert.session", () => {
    const entries = [INIT, READY, db("db:upsert", {})];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("session"))).toBe(true);
  });

  test("missing required fields: db:upsert.session.sessionId", () => {
    const entries = [INIT, READY, db("db:upsert", { session: { name: "test" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("session.sessionId"))).toBe(
      true,
    );
  });

  test("missing required fields: metrics:observe.value", () => {
    const entries = [INIT, READY, db("metrics:observe", { name: "hist" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("value"))).toBe(true);
  });

  test("missing required fields: restore_sessions.sessions", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "restore_sessions" } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("sessions"))).toBe(true);
  });

  test("missing required fields: work_item_event.event", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "work_item_event" } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("event"))).toBe(true);
  });

  test("missing required fields: monitor:event.input", () => {
    const entries = [INIT, READY, db("monitor:event", {})];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("input"))).toBe(true);
  });

  test("MCP message without jsonrpc field fails", () => {
    const entries = [INIT, READY, entry({ dir: "daemon->worker", kind: "mcp", payload: { id: 1, method: "test" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-format")).toBe(true);
  });

  test("tools_changed with wrong direction detected", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "worker->daemon", kind: "control", payload: { type: "tools_changed" } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "direction" && v.message.includes("tools_changed"))).toBe(true);
  });

  test("unknown control type detected", () => {
    const entries = [INIT, READY, entry({ dir: "daemon->worker", kind: "control", payload: { type: "reedy" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "unknown-type" && v.message.includes("reedy"))).toBe(true);
  });

  test("unknown DB type detected", () => {
    const entries = [INIT, READY, db("db:unknown_event", { sessionId: "s1" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "unknown-type" && v.message.includes("db:unknown_event"))).toBe(
      true,
    );
  });
});

// ── Deeper validation from #2614 findings ─────────────────────────

describe("deeper validation (#2614 findings)", () => {
  test("restore_sessions: element must be object with sessionId and provider", () => {
    const entries = [
      INIT,
      READY,
      entry({
        dir: "daemon->worker",
        kind: "control",
        payload: { type: "restore_sessions", sessions: ["not-an-object"] },
      }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("sessions[0]"))).toBe(true);
  });

  test("restore_sessions: element missing sessionId", () => {
    const entries = [
      INIT,
      READY,
      entry({
        dir: "daemon->worker",
        kind: "control",
        payload: { type: "restore_sessions", sessions: [{ provider: "mock" }] },
      }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(
      report.violations.some(
        (v) => v.rule === "required-field" && v.message.includes("sessions[0]") && v.message.includes("sessionId"),
      ),
    ).toBe(true);
  });

  test("restore_sessions: element missing provider", () => {
    const entries = [
      INIT,
      READY,
      entry({
        dir: "daemon->worker",
        kind: "control",
        payload: { type: "restore_sessions", sessions: [{ sessionId: "s1" }] },
      }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(
      report.violations.some(
        (v) => v.rule === "required-field" && v.message.includes("sessions[0]") && v.message.includes("provider"),
      ),
    ).toBe(true);
  });

  test("restore_sessions: valid element passes", () => {
    const entries = [
      INIT,
      READY,
      entry({
        dir: "daemon->worker",
        kind: "control",
        payload: { type: "restore_sessions", sessions: [{ sessionId: "s1", provider: "mock" }] },
      }),
    ];
    const report = validateRecording(entries, "test.ndjson");
    expect(report.violations.filter((v) => v.rule === "required-field")).toHaveLength(0);
  });

  test("work_item_event: event must be object not primitive", () => {
    const entries = [
      INIT,
      READY,
      entry({
        dir: "daemon->worker",
        kind: "control",
        payload: { type: "work_item_event", event: "not-an-object" },
      }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("must be an object"))).toBe(
      true,
    );
  });

  test("monitor:event: input must be object not primitive", () => {
    const entries = [INIT, READY, db("monitor:event", { input: 42 })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "required-field" && v.message.includes("must be an object"))).toBe(
      true,
    );
  });

  test("MCP response: result and error mutual exclusion", () => {
    const entries = [INIT, READY, mcp("worker->daemon", { id: 1, result: {}, error: { code: -1, message: "x" } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-format" && v.message.includes("mutual exclusion"))).toBe(true);
  });

  test("MCP response: must have id", () => {
    const entries = [
      INIT,
      READY,
      entry({ dir: "worker->daemon", kind: "mcp", payload: { jsonrpc: "2.0", result: {} } }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-format" && v.message.includes("id field"))).toBe(true);
  });

  test("MCP response: must not have method field", () => {
    const entries = [INIT, READY, mcp("worker->daemon", { id: 1, result: {}, method: "tools/list" })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-format" && v.message.includes("must not have a method"))).toBe(
      true,
    );
  });

  test("MCP request: method must be string", () => {
    const entries = [INIT, READY, mcp("daemon->worker", { id: 1, method: 42 })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(
      report.violations.some((v) => v.rule === "mcp-format" && v.message.includes("method must be a string")),
    ).toBe(true);
  });

  test("MCP notification: no id, has method — passes", () => {
    const entries = [INIT, READY, mcp("worker->daemon", { method: "notifications/tools/list_changed" })];
    const report = validateRecording(entries, "test.ndjson");
    expect(report.pass).toBe(true);
  });
});

// ── MCP correlation ───────────────────────────────────────────────

describe("MCP request/response correlation", () => {
  test("matched request/response passes", () => {
    const entries: RecordingEntry[] = [
      INIT,
      READY,
      mcp("daemon->worker", { id: 1, method: "tools/list" }),
      mcp("worker->daemon", { id: 1, result: { tools: [] } }),
    ];
    const report = validateRecording(entries, "test.ndjson");
    expect(report.pass).toBe(true);
  });

  test("orphan response detected", () => {
    const entries: RecordingEntry[] = [INIT, READY, mcp("worker->daemon", { id: 99, result: { tools: [] } })];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-correlation" && v.message.includes("99"))).toBe(true);
  });

  test("duplicate in-flight request ID detected", () => {
    const entries: RecordingEntry[] = [
      INIT,
      READY,
      mcp("daemon->worker", { id: 1, method: "tools/list" }),
      mcp("daemon->worker", { id: 1, method: "prompts/list" }),
    ];
    const report = validateRecording(entries, "bad.ndjson");
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mcp-correlation" && v.message.includes("duplicate"))).toBe(true);
  });

  test("notifications (no id) are not correlated", () => {
    const entries: RecordingEntry[] = [
      INIT,
      READY,
      mcp("worker->daemon", { method: "notifications/tools/list_changed" }),
    ];
    const report = validateRecording(entries, "test.ndjson");
    expect(report.pass).toBe(true);
  });
});

// ── Mock-driver replay ────────────────────────────────────────────

const MOCK_WORKER_PATH = join(import.meta.dir, "../../packages/daemon/src/mock-session-worker.ts");

describe("replayThroughMock", () => {
  const activeWorkers: Worker[] = [];

  afterEach(() => {
    for (const w of activeWorkers) {
      try {
        w.onmessage = null;
        w.onerror = null;
        w.terminate();
      } catch {}
    }
    activeWorkers.length = 0;
  });

  test("init-only recording replays through mock worker", async () => {
    // Record phase: spawn mock worker, capture actual output
    const recorded: RecordingEntry[] = [];
    const worker = new Worker(MOCK_WORKER_PATH);
    activeWorkers.push(worker);

    try {
      const initPayload = { type: "init", protocol_version: 1 };
      recorded.push(entry({ dir: "daemon->worker", kind: "control", payload: initPayload }));

      const readyPayload = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        worker.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (event: ErrorEvent | Event) => {
          clearTimeout(timer);
          reject(new Error(event instanceof ErrorEvent ? event.message : String(event)));
        };
        worker.postMessage(initPayload);
      });

      recorded.push(entry({ dir: "worker->daemon", kind: "control", payload: readyPayload }));
    } finally {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      activeWorkers.length = 0;
    }

    // Replay phase
    const report = await replayThroughMock(recorded, "init-only.ndjson", {
      workerPath: MOCK_WORKER_PATH,
    });

    expect(report.pass).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.expectedWorkerMessages).toBe(1);
    expect(report.actualWorkerMessages).toBe(1);
  });

  test("full mock_prompt recording replays correctly", async () => {
    // Create a temp script for the mock worker
    const scriptDir = tmpFile("scripts");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "test-script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { emit: "response", text: "hello from mock" },
        { emit: "result", text: "done" },
      ]),
    );

    // Record phase: spawn worker, do full MCP exchange, collect output
    const recorded: RecordingEntry[] = [];
    const workerMessages: unknown[] = [];
    const worker = new Worker(MOCK_WORKER_PATH);
    activeWorkers.push(worker);

    try {
      const initPayload = { type: "init", protocol_version: 1 };
      recorded.push(entry({ dir: "daemon->worker", kind: "control", payload: initPayload }));

      // Wait for ready
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        worker.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          workerMessages.push(event.data);
          recorded.push(entry({ dir: "worker->daemon", kind: "control", payload: event.data }));
          resolve();
        };
        worker.onerror = (ev: ErrorEvent | Event) => {
          clearTimeout(timer);
          reject(new Error(ev instanceof ErrorEvent ? ev.message : String(ev)));
        };
        worker.postMessage(initPayload);
      });

      // Send MCP initialize
      const initializeMsg = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "replay-test", version: "0.1.0" },
        },
      };
      recorded.push(entry({ dir: "daemon->worker", kind: "mcp", payload: initializeMsg }));

      // Collect MCP initialize response
      const initResponse = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mcp init timeout")), 5000);
        worker.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          workerMessages.push(event.data);
          recorded.push(entry({ dir: "worker->daemon", kind: "mcp", payload: event.data }));
          resolve(event.data);
        };
        worker.postMessage(initializeMsg);
      });

      // Send initialized notification
      const initializedMsg = { jsonrpc: "2.0", method: "notifications/initialized" };
      recorded.push(entry({ dir: "daemon->worker", kind: "mcp", payload: initializedMsg }));
      worker.postMessage(initializedMsg);

      // Send tools/call with mock_prompt
      const toolCallMsg = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "mock_prompt",
          arguments: { prompt: scriptPath, cwd: scriptDir, wait: true },
        },
      };
      recorded.push(entry({ dir: "daemon->worker", kind: "mcp", payload: toolCallMsg }));

      // Collect all worker→daemon messages until we get the tool call response
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tool call timeout")), 10000);
        worker.onmessage = (event: MessageEvent) => {
          const data = event.data;
          workerMessages.push(data);
          const kind = classifyForRecording(data);
          recorded.push(entry({ dir: "worker->daemon", kind, payload: data }));

          // The tool call response has the matching id
          if (
            typeof data === "object" &&
            data !== null &&
            "jsonrpc" in data &&
            "id" in data &&
            (data as Record<string, unknown>).id === 1
          ) {
            clearTimeout(timer);
            resolve();
          }
        };
        worker.postMessage(toolCallMsg);
      });
    } finally {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      activeWorkers.length = 0;
    }

    // Replay phase
    const report = await replayThroughMock(recorded, "full.ndjson", {
      workerPath: MOCK_WORKER_PATH,
    });

    expect(report.violations).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.actualWorkerMessages).toBe(report.expectedWorkerMessages);
  });

  test("rejects recording with no daemon→worker messages", async () => {
    const report = await replayThroughMock([], "empty.ndjson", {
      workerPath: MOCK_WORKER_PATH,
    });

    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mock-replay")).toBe(true);
  });

  test("rejects recording without init as first message", async () => {
    const entries = [mcp("daemon->worker", { id: 1, method: "tools/list" })];
    const report = await replayThroughMock(entries, "no-init.ndjson", {
      workerPath: MOCK_WORKER_PATH,
    });

    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mock-replay" && v.message.includes("init"))).toBe(true);
  });

  test("detects count mismatch when recording has extra expected messages", async () => {
    // A recording that claims the worker sent more messages than it actually will
    const entries: RecordingEntry[] = [
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "init", protocol_version: 1 } }),
      entry({ dir: "worker->daemon", kind: "control", payload: { type: "ready", supported_protocol_version: 1 } }),
      // Fake extra message the worker won't produce
      db("db:end", { sessionId: "phantom" }),
    ];

    const report = await replayThroughMock(entries, "extra.ndjson", {
      workerPath: MOCK_WORKER_PATH,
      timeoutMs: 500, // short timeout — testing count detection, not timeout duration
    });

    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.rule === "mock-replay-count")).toBe(true);
  });

  test("Phase-2 worker crash produces mock-worker-crash violation, not silent count mismatch", async () => {
    // Worker that sends ready on init but crashes on the next message
    const crashWorkerPath = tmpFile("crash-worker.ts");
    writeFileSync(
      crashWorkerPath,
      `self.onmessage = (ev) => {
  if (ev.data?.type === "init") {
    self.postMessage({ type: "ready", supported_protocol_version: 1 });
    self.onmessage = () => { throw new Error("intentional phase-2 crash"); };
  }
};`,
    );

    const entries: RecordingEntry[] = [
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "init", protocol_version: 1 } }),
      entry({ dir: "worker->daemon", kind: "control", payload: { type: "ready", supported_protocol_version: 1 } }),
      // Extra expected message that won't arrive because the worker crashes
      db("db:end", { sessionId: "test" }),
      // Trigger message that causes the crash
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "shutdown" } }),
    ];

    const report = await replayThroughMock(entries, "crash.ndjson", {
      workerPath: crashWorkerPath,
      timeoutMs: 3000,
    });

    expect(report.pass).toBe(false);
    // Crash must surface as mock-worker-crash, not silently as count mismatch alone
    expect(report.violations.some((v) => v.rule === "mock-worker-crash")).toBe(true);
  });

  test("short Phase-2 timeoutMs does not starve the Phase-1 init handshake (#2703)", async () => {
    // Worker whose ready arrives 250ms after init — a stand-in for
    // spawn/transpile latency under parallel suite load. The recording's only
    // expected message (ready) is collected during Phase 1, so Phase 2 is
    // never entered: timeoutMs: 50 exists solely to prove the Phase-1 init
    // deadline no longer reads it. On pre-fix code this fails in ~50ms with
    // "mock worker init timeout"; with initTimeoutMs (default 10s) it passes.
    const slowInitWorkerPath = tmpFile("slow-init-worker.ts");
    writeFileSync(
      slowInitWorkerPath,
      `self.onmessage = async (ev) => {
  if (ev.data?.type === "init") {
    await new Promise((r) => setTimeout(r, 250));
    self.postMessage({ type: "ready", supported_protocol_version: 1 });
  }
};`,
    );

    const entries: RecordingEntry[] = [
      entry({ dir: "daemon->worker", kind: "control", payload: { type: "init", protocol_version: 1 } }),
      entry({ dir: "worker->daemon", kind: "control", payload: { type: "ready", supported_protocol_version: 1 } }),
    ];

    const report = await replayThroughMock(entries, "slow-init.ndjson", {
      workerPath: slowInitWorkerPath,
      timeoutMs: 50, // far below the worker's init latency — must not cap Phase 1
    });

    expect(report.pass).toBe(true);
    expect(report.violations).toEqual([]);
  });
});

// ── parseRecording ────────────────────────────────────────────────

describe("parseRecording", () => {
  test("parses valid NDJSON file", () => {
    const path = tmpFile("valid.ndjson");
    const lines = [
      JSON.stringify({ t: 1000, dir: "daemon->worker", kind: "control", payload: { type: "init" } }),
      JSON.stringify({ t: 1001, dir: "worker->daemon", kind: "control", payload: { type: "ready" } }),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);

    const entries = parseRecording(path);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("control");
    expect(entries[1].kind).toBe("control");
  });

  test("throws on invalid JSON", () => {
    const path = tmpFile("bad.ndjson");
    writeFileSync(path, "not json\n");
    expect(() => parseRecording(path)).toThrow("line 1: invalid JSON");
  });

  test("throws on non-object JSON (array)", () => {
    const path = tmpFile("array.ndjson");
    writeFileSync(path, "[1, 2, 3]\n");
    expect(() => parseRecording(path)).toThrow("line 1: entry must be a JSON object");
  });

  test("throws on non-object JSON (string)", () => {
    const path = tmpFile("string.ndjson");
    writeFileSync(path, '"hello"\n');
    expect(() => parseRecording(path)).toThrow("line 1: entry must be a JSON object");
  });

  test("throws on missing required fields", () => {
    const path = tmpFile("missing.ndjson");
    writeFileSync(path, '{"t": 1000, "dir": "daemon->worker"}\n');
    expect(() => parseRecording(path)).toThrow("line 1: entry missing required fields");
  });

  test("skips blank lines", () => {
    const path = tmpFile("blank.ndjson");
    const line = JSON.stringify({ t: 1000, dir: "daemon->worker", kind: "control", payload: { type: "init" } });
    writeFileSync(path, `${line}\n\n\n`);

    const entries = parseRecording(path);
    expect(entries).toHaveLength(1);
  });
});

// ── Helper ────────────────────────────────────────────────────────

function classifyForRecording(data: unknown): "control" | "db" | "mcp" {
  if (typeof data !== "object" || data === null) return "mcp";
  const obj = data as Record<string, unknown>;
  if ("jsonrpc" in obj) return "mcp";
  if ("type" in obj && typeof obj.type === "string") {
    const t = obj.type;
    if (t.startsWith("db:") || t.startsWith("metrics:") || t === "monitor:event") return "db";
    return "control";
  }
  return "mcp";
}
