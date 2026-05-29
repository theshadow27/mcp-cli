import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordingEntry } from "@mcp-cli/core";
import { parseRecording, validateRecording } from "./replay";

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
      db("db:upsert", { session: { sessionId: "s1", state: "active" } }),
      db("db:state", { sessionId: "s1", state: "idle" }),
      db("db:cost", { sessionId: "s1", cost: 0.01, tokens: 100 }),
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
});

describe("parseRecording", () => {
  test("parses valid NDJSON file", () => {
    const path = join(tmpdir(), `replay-test-${process.pid}-${Date.now()}.ndjson`);
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
    const path = join(tmpdir(), `replay-test-bad-${process.pid}-${Date.now()}.ndjson`);
    writeFileSync(path, "not json\n");
    expect(() => parseRecording(path)).toThrow("line 1: invalid JSON");
  });

  test("skips blank lines", () => {
    const path = join(tmpdir(), `replay-test-blank-${process.pid}-${Date.now()}.ndjson`);
    const line = JSON.stringify({ t: 1000, dir: "daemon->worker", kind: "control", payload: { type: "init" } });
    writeFileSync(path, `${line}\n\n\n`);

    const entries = parseRecording(path);
    expect(entries).toHaveLength(1);
  });
});
