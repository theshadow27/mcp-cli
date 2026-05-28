import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NdjsonRecorder, type RecordingEntry, classifyMessageKind } from "./recording";

describe("classifyMessageKind", () => {
  test("jsonrpc field → mcp", () => {
    expect(classifyMessageKind({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe("mcp");
  });

  test("jsonrpc notification → mcp", () => {
    expect(classifyMessageKind({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe("mcp");
  });

  test("type: init → control", () => {
    expect(classifyMessageKind({ type: "init", daemonId: "test" })).toBe("control");
  });

  test("type: ready → control", () => {
    expect(classifyMessageKind({ type: "ready" })).toBe("control");
  });

  test("type: error → control", () => {
    expect(classifyMessageKind({ type: "error", message: "failed" })).toBe("control");
  });

  test("type: tools_changed → control", () => {
    expect(classifyMessageKind({ type: "tools_changed" })).toBe("control");
  });

  test("type: restore_sessions → control", () => {
    expect(classifyMessageKind({ type: "restore_sessions", sessions: [] })).toBe("control");
  });

  test("type: work_item_event → control", () => {
    expect(classifyMessageKind({ type: "work_item_event", event: {} })).toBe("control");
  });

  test("type: db:upsert → db", () => {
    expect(classifyMessageKind({ type: "db:upsert", session: { sessionId: "x" } })).toBe("db");
  });

  test("type: db:state → db", () => {
    expect(classifyMessageKind({ type: "db:state", sessionId: "x", state: "idle" })).toBe("db");
  });

  test("type: db:cost → db", () => {
    expect(classifyMessageKind({ type: "db:cost", sessionId: "x", cost: 0.1, tokens: 100 })).toBe("db");
  });

  test("type: db:disconnected → db", () => {
    expect(classifyMessageKind({ type: "db:disconnected", sessionId: "x", reason: "exit" })).toBe("db");
  });

  test("type: db:end → db", () => {
    expect(classifyMessageKind({ type: "db:end", sessionId: "x" })).toBe("db");
  });

  test("type: metrics:inc → db", () => {
    expect(classifyMessageKind({ type: "metrics:inc", name: "counter" })).toBe("db");
  });

  test("type: metrics:observe → db", () => {
    expect(classifyMessageKind({ type: "metrics:observe", name: "hist", value: 1.5 })).toBe("db");
  });

  test("type: monitor:event → db", () => {
    expect(classifyMessageKind({ type: "monitor:event", input: {} })).toBe("db");
  });

  test("null → mcp (fallback)", () => {
    expect(classifyMessageKind(null)).toBe("mcp");
  });

  test("non-object → mcp (fallback)", () => {
    expect(classifyMessageKind("hello")).toBe("mcp");
  });
});

describe("NdjsonRecorder", () => {
  const dir = join(tmpdir(), `recording-test-${process.pid}`);
  const paths: string[] = [];

  afterEach(async () => {
    for (const p of paths) {
      rmSync(p, { force: true });
    }
    paths.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function recPath(name: string): string {
    const p = join(dir, `${name}.ndjson`);
    paths.push(p);
    return p;
  }

  test("writes NDJSON entries with correct format", async () => {
    const path = recPath("basic");
    const rec = new NdjsonRecorder(path);

    rec.record("daemon->worker", "control", { type: "init", daemonId: "test" });
    rec.record("worker->daemon", "control", { type: "ready" });
    rec.record("daemon->worker", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    rec.record("worker->daemon", "db", { type: "db:state", sessionId: "s1", state: "idle" });
    await rec.close();

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(4);

    const entries = lines.map((l) => JSON.parse(l) as RecordingEntry);

    expect(entries[0].dir).toBe("daemon->worker");
    expect(entries[0].kind).toBe("control");
    expect(entries[0].payload).toEqual({ type: "init", daemonId: "test" });
    expect(typeof entries[0].t).toBe("number");
    expect(entries[0].t).toBeGreaterThan(0);

    expect(entries[1].dir).toBe("worker->daemon");
    expect(entries[1].kind).toBe("control");

    expect(entries[2].dir).toBe("daemon->worker");
    expect(entries[2].kind).toBe("mcp");

    expect(entries[3].dir).toBe("worker->daemon");
    expect(entries[3].kind).toBe("db");
  });

  test("recordMessage auto-classifies kind", async () => {
    const path = recPath("auto");
    const rec = new NdjsonRecorder(path);

    rec.recordMessage("daemon->worker", { type: "init" });
    rec.recordMessage("worker->daemon", { type: "db:cost", sessionId: "x", cost: 0, tokens: 0 });
    rec.recordMessage("daemon->worker", { jsonrpc: "2.0", id: 1, method: "tools/call" });
    await rec.close();

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l) as RecordingEntry);

    expect(entries[0].kind).toBe("control");
    expect(entries[1].kind).toBe("db");
    expect(entries[2].kind).toBe("mcp");
  });

  test("close() is idempotent", async () => {
    const path = recPath("idempotent");
    const rec = new NdjsonRecorder(path);
    rec.record("daemon->worker", "control", { type: "init" });
    await rec.close();
    await rec.close();

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("writes after close are silently dropped", async () => {
    const path = recPath("closed");
    const rec = new NdjsonRecorder(path);
    rec.record("daemon->worker", "control", { type: "init" });
    await rec.close();
    rec.record("daemon->worker", "control", { type: "tools_changed" });

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("timestamps are monotonically increasing", async () => {
    const path = recPath("monotonic");
    const rec = new NdjsonRecorder(path);

    for (let i = 0; i < 10; i++) {
      rec.record("daemon->worker", "mcp", { jsonrpc: "2.0", id: i, method: "ping" });
    }
    await rec.close();

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const timestamps = lines.map((l) => (JSON.parse(l) as RecordingEntry).t);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });

  test("creates parent directories", async () => {
    const path = join(dir, "nested", "deep", "recording.ndjson");
    paths.push(path);
    const rec = new NdjsonRecorder(path);
    rec.record("daemon->worker", "control", { type: "init" });
    await rec.close();

    const content = readFileSync(path, "utf-8").trim();
    expect(content).not.toBe("");
  });
});
