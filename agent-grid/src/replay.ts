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

const KNOWN_DB_TYPES = new Set([
  "db:upsert",
  "db:state",
  "db:cost",
  "db:disconnected",
  "db:end",
  "metrics:inc",
  "metrics:observe",
  "monitor:event",
]);

const KNOWN_CONTROL_TYPES = new Set([...DAEMON_TO_WORKER_CONTROL_TYPES, ...WORKER_TO_DAEMON_CONTROL_TYPES]);

// Session state transitions that forwardSessionEvent can produce.
// Mirrors the mock-session-worker's session lifecycle:
//   handlePrompt → db:upsert(connecting)
//   runScript    → db:state(active) → db:upsert(init) → [work] → db:state(idle) → db:end
const VALID_STATE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  connecting: new Set(["active"]),
  active: new Set(["init", "idle", "waiting_permission"]),
  init: new Set(["active", "idle", "waiting_permission"]),
  waiting_permission: new Set(["active", "idle"]),
  idle: new Set(["active", "connecting", "ended"]),
};

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

function hasField(payload: unknown, field: string): boolean {
  return getField(payload, field) !== undefined;
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
    case "restore_sessions":
      if (!Array.isArray(getField(entry.payload, "sessions"))) fail("sessions", "array");
      break;
    case "work_item_event":
      if (!hasField(entry.payload, "event")) fail("event", "object");
      break;
    case "monitor:event":
      if (!hasField(entry.payload, "input")) fail("input", "object");
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

// ── Session lifecycle replay ──────────────────────────────────────
// Models the mock-session-worker's forwardSessionEvent + handlePrompt
// to validate that DB events form a legal session lifecycle.

interface SessionState {
  state: string;
  ended: boolean;
}

function getSessionIdFromPayload(payload: unknown): string | undefined {
  const sessionId = getField(payload, "sessionId") as string | undefined;
  if (sessionId) return sessionId;
  const session = getField(payload, "session");
  if (typeof session === "object" && session !== null) {
    return getField(session, "sessionId") as string | undefined;
  }
  return undefined;
}

function getStateFromPayload(type: string, payload: unknown): string | undefined {
  if (type === "db:state") return getField(payload, "state") as string | undefined;
  if (type === "db:upsert") {
    const session = getField(payload, "session");
    if (typeof session === "object" && session !== null) {
      return getField(session, "state") as string | undefined;
    }
  }
  return undefined;
}

function replaySessionLifecycle(entries: RecordingEntry[], violations: ReplayViolation[]): void {
  const sessions = new Map<string, SessionState>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.kind !== "db") continue;
    const line = i + 1;
    const type = getType(entry.payload);
    if (!type) continue;

    const sessionId = getSessionIdFromPayload(entry.payload);
    if (!sessionId) continue;

    const session = sessions.get(sessionId);

    if (session?.ended) {
      violations.push({
        line,
        rule: "lifecycle",
        message: `session "${sessionId}" received ${type} after db:end`,
      });
      continue;
    }

    if (type === "db:upsert") {
      const newState = getStateFromPayload(type, entry.payload);
      if (!session) {
        sessions.set(sessionId, { state: newState ?? "connecting", ended: false });
      } else if (newState) {
        const allowed = VALID_STATE_TRANSITIONS[session.state];
        if (allowed && !allowed.has(newState)) {
          violations.push({
            line,
            rule: "lifecycle",
            message: `session "${sessionId}" invalid state transition: "${session.state}" → "${newState}" (via ${type})`,
          });
        }
        session.state = newState;
      }
      continue;
    }

    if (!session) {
      violations.push({
        line,
        rule: "lifecycle",
        message: `session "${sessionId}" received ${type} before db:upsert`,
      });
      continue;
    }

    if (type === "db:state") {
      const newState = getStateFromPayload(type, entry.payload);
      if (newState) {
        const allowed = VALID_STATE_TRANSITIONS[session.state];
        if (allowed && !allowed.has(newState)) {
          violations.push({
            line,
            rule: "lifecycle",
            message: `session "${sessionId}" invalid state transition: "${session.state}" → "${newState}" (via ${type})`,
          });
        }
        session.state = newState;
      }
    } else if (type === "db:end") {
      session.ended = true;
      session.state = "ended";
    } else if (type === "db:disconnected") {
      session.state = "disconnected";
    }
  }
}

// ── MCP request/response correlation ──────────────────────────────

function validateMcpCorrelation(entries: RecordingEntry[], violations: ReplayViolation[]): void {
  const pendingRequests = new Map<string | number, number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.kind !== "mcp") continue;
    const line = i + 1;
    const payload = entry.payload as Record<string, unknown> | null;
    if (typeof payload !== "object" || payload === null) continue;

    const id = payload.id as string | number | undefined;
    if (id === undefined) continue;

    if ("method" in payload) {
      pendingRequests.set(id, line);
    } else if ("result" in payload || "error" in payload) {
      if (!pendingRequests.has(id)) {
        violations.push({
          line,
          rule: "mcp-correlation",
          message: `MCP response id=${JSON.stringify(id)} has no matching request`,
        });
      } else {
        pendingRequests.delete(id);
      }
    }
  }
}

// ── Main validation ───────────────────────────────────────────────

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
      if (!KNOWN_CONTROL_TYPES.has(type)) {
        violations.push({
          line,
          rule: "unknown-type",
          message: `unknown control type "${type}"`,
        });
      }
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

    if (entry.kind === "db" && type && !KNOWN_DB_TYPES.has(type)) {
      violations.push({
        line,
        rule: "unknown-type",
        message: `unknown DB/metrics type "${type}"`,
      });
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

  if (entries.length > 0 && sawReady) {
    replaySessionLifecycle(entries, violations);
    validateMcpCorrelation(entries, violations);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: invalid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`line ${i + 1}: entry must be a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (!("t" in obj && "dir" in obj && "kind" in obj && "payload" in obj)) {
      throw new Error(`line ${i + 1}: entry missing required fields (t, dir, kind, payload)`);
    }
    return parsed as RecordingEntry;
  });
}
