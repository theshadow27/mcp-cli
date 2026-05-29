import { readFileSync } from "node:fs";
import { type RecordingEntry, type RecordingKind, classifyMessageKind } from "@mcp-cli/core";

export interface ReplayViolation {
  line: number;
  rule: string;
  message: string;
}

export interface ReplayReport {
  file: string;
  entries: number;
  violations: ReplayViolation[];
  pass: boolean;
}

const VALID_DIRECTIONS = new Set(["daemon->worker", "worker->daemon"]);
const VALID_KINDS: ReadonlySet<string> = new Set<RecordingKind>(["control", "db", "mcp"]);

const DAEMON_TO_WORKER_CONTROL_TYPES = new Set(["init", "tools_changed", "restore_sessions", "work_item_event"]);

const WORKER_TO_DAEMON_CONTROL_TYPES = new Set(["ready", "error"]);

const DB_TYPES = new Set([
  "db:upsert",
  "db:state",
  "db:cost",
  "db:disconnected",
  "db:end",
  "metrics:inc",
  "metrics:observe",
  "monitor:event",
]);

function getType(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "type" in payload) {
    const t = (payload as Record<string, unknown>).type;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function getField(payload: unknown, field: string): unknown {
  if (typeof payload === "object" && payload !== null && field in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>)[field];
  }
  return undefined;
}

function hasStringField(payload: unknown, field: string): boolean {
  return typeof getField(payload, field) === "string";
}

function hasNumberField(payload: unknown, field: string): boolean {
  return typeof getField(payload, field) === "number";
}

function validateRequiredFields(entry: RecordingEntry, line: number, violations: ReplayViolation[]): void {
  const type = getType(entry.payload);
  if (entry.kind !== "control" && entry.kind !== "db") return;
  if (!type) return;

  const fail = (field: string, expected: string) => {
    violations.push({
      line,
      rule: "required-field",
      message: `${type} missing required field "${field}" (expected ${expected})`,
    });
  };

  switch (type) {
    case "error":
      if (!hasStringField(entry.payload, "message")) fail("message", "string");
      break;
    case "db:upsert": {
      const session = getField(entry.payload, "session");
      if (typeof session !== "object" || session === null) {
        fail("session", "object");
      } else if (!hasStringField(session, "sessionId")) {
        fail("session.sessionId", "string");
      }
      break;
    }
    case "db:state":
      if (!hasStringField(entry.payload, "sessionId")) fail("sessionId", "string");
      if (!hasStringField(entry.payload, "state")) fail("state", "string");
      break;
    case "db:cost":
      if (!hasStringField(entry.payload, "sessionId")) fail("sessionId", "string");
      if (!hasNumberField(entry.payload, "cost")) fail("cost", "number");
      if (!hasNumberField(entry.payload, "tokens")) fail("tokens", "number");
      break;
    case "db:disconnected":
      if (!hasStringField(entry.payload, "sessionId")) fail("sessionId", "string");
      if (!hasStringField(entry.payload, "reason")) fail("reason", "string");
      break;
    case "db:end":
      if (!hasStringField(entry.payload, "sessionId")) fail("sessionId", "string");
      break;
    case "metrics:inc":
      if (!hasStringField(entry.payload, "name")) fail("name", "string");
      break;
    case "metrics:observe":
      if (!hasStringField(entry.payload, "name")) fail("name", "string");
      if (!hasNumberField(entry.payload, "value")) fail("value", "number");
      break;
  }
}

function validateMcpMessage(payload: unknown, line: number, violations: ReplayViolation[]): void {
  if (typeof payload !== "object" || payload === null) {
    violations.push({ line, rule: "mcp-format", message: "MCP message must be an object" });
    return;
  }
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    violations.push({
      line,
      rule: "mcp-format",
      message: `MCP message must have jsonrpc: "2.0", got ${JSON.stringify(obj.jsonrpc)}`,
    });
  }
}

export function validateRecording(entries: RecordingEntry[], file: string): ReplayReport {
  const violations: ReplayViolation[] = [];
  let sawInit = false;
  let sawReady = false;
  let sawError = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const line = i + 1;

    if (!VALID_DIRECTIONS.has(entry.dir)) {
      violations.push({ line, rule: "direction", message: `invalid direction "${entry.dir}"` });
    }

    if (!VALID_KINDS.has(entry.kind)) {
      violations.push({ line, rule: "kind", message: `invalid kind "${entry.kind}"` });
    }

    const expectedKind = classifyMessageKind(entry.payload);
    if (entry.kind !== expectedKind) {
      violations.push({
        line,
        rule: "kind-mismatch",
        message: `declared kind "${entry.kind}" but payload classifies as "${expectedKind}"`,
      });
    }

    if (typeof entry.t !== "number" || entry.t <= 0) {
      violations.push({
        line,
        rule: "timestamp",
        message: `timestamp must be a positive number, got ${JSON.stringify(entry.t)}`,
      });
    }

    const type = getType(entry.payload);

    if (entry.kind === "control" && type) {
      if (DAEMON_TO_WORKER_CONTROL_TYPES.has(type) && entry.dir !== "daemon->worker") {
        violations.push({
          line,
          rule: "direction",
          message: `control "${type}" must be daemon->worker, got "${entry.dir}"`,
        });
      }
      if (WORKER_TO_DAEMON_CONTROL_TYPES.has(type) && entry.dir !== "worker->daemon") {
        violations.push({
          line,
          rule: "direction",
          message: `control "${type}" must be worker->daemon, got "${entry.dir}"`,
        });
      }
    }

    if (entry.kind === "db" && entry.dir !== "worker->daemon") {
      violations.push({
        line,
        rule: "direction",
        message: `DB/metrics events must be worker->daemon, got "${entry.dir}"`,
      });
    }

    if (i === 0) {
      if (type !== "init" || entry.kind !== "control") {
        violations.push({ line, rule: "handshake", message: "first message must be init (control, daemon->worker)" });
      } else {
        sawInit = true;
      }
    } else if (i === 1 && sawInit) {
      if (entry.kind !== "control" || (type !== "ready" && type !== "error")) {
        violations.push({
          line,
          rule: "handshake",
          message: "second message must be ready or error (control, worker->daemon)",
        });
      } else {
        if (type === "ready") sawReady = true;
        if (type === "error") sawError = true;
      }
    }

    if (sawError && i > 1) {
      violations.push({ line, rule: "post-error", message: "no messages should follow an error handshake response" });
    }

    if (entry.kind === "mcp" && !sawReady) {
      violations.push({ line, rule: "handshake", message: "MCP messages must not appear before ready handshake" });
    }

    if (entry.kind === "mcp") {
      validateMcpMessage(entry.payload, line, violations);
    }

    validateRequiredFields(entry, line, violations);
  }

  if (entries.length > 0 && !sawInit) {
    violations.push({ line: 1, rule: "handshake", message: "recording does not contain an init message" });
  }

  return {
    file,
    entries: entries.length,
    violations,
    pass: violations.length === 0,
  };
}

export function parseRecording(filePath: string): RecordingEntry[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as RecordingEntry;
    } catch {
      throw new Error(`line ${i + 1}: invalid JSON`);
    }
  });
}
