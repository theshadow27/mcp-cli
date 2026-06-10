import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface MockReplayReport {
  file: string;
  entries: number;
  violations: ReplayViolation[];
  pass: boolean;
  expectedWorkerMessages: number;
  actualWorkerMessages: number;
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
    case "restore_sessions": {
      const sessions = getField(entry.payload, "sessions");
      if (!Array.isArray(sessions)) {
        fail("sessions", "array");
      } else {
        for (let j = 0; j < sessions.length; j++) {
          const el = sessions[j];
          if (typeof el !== "object" || el === null || Array.isArray(el)) {
            violations.push({
              line,
              rule: "required-field",
              message: `restore_sessions.sessions[${j}] must be an object`,
            });
          } else {
            if (!hasStringField(el, "sessionId")) {
              violations.push({
                line,
                rule: "required-field",
                message: `restore_sessions.sessions[${j}] missing required field "sessionId" (expected string)`,
              });
            }
            if (!hasStringField(el, "provider")) {
              violations.push({
                line,
                rule: "required-field",
                message: `restore_sessions.sessions[${j}] missing required field "provider" (expected string)`,
              });
            }
          }
        }
      }
      break;
    }
    case "work_item_event": {
      const event = getField(entry.payload, "event");
      if (!event) {
        fail("event", "object");
      } else if (typeof event !== "object" || event === null) {
        violations.push({
          line,
          rule: "required-field",
          message: `work_item_event.event must be an object, got ${typeof event}`,
        });
      }
      break;
    }
    case "monitor:event": {
      const input = getField(entry.payload, "input");
      if (!input) {
        fail("input", "object");
      } else if (typeof input !== "object" || input === null) {
        violations.push({
          line,
          rule: "required-field",
          message: `monitor:event.input must be an object, got ${typeof input}`,
        });
      }
      break;
    }
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
    return;
  }

  const hasMethod = "method" in obj;
  const hasResult = "result" in obj;
  const hasError = "error" in obj;
  const hasId = "id" in obj;

  if (hasResult && hasError) {
    violations.push({
      line,
      rule: "mcp-format",
      message: "MCP message cannot have both result and error (mutual exclusion)",
    });
  }

  if (hasResult || hasError) {
    if (!hasId) {
      violations.push({
        line,
        rule: "mcp-format",
        message: "MCP response must have an id field",
      });
    }
    if (hasMethod) {
      violations.push({
        line,
        rule: "mcp-format",
        message: "MCP response must not have a method field",
      });
    }
  }

  if (hasMethod && typeof obj.method !== "string") {
    violations.push({
      line,
      rule: "mcp-format",
      message: `MCP method must be a string, got ${typeof obj.method}`,
    });
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
      if (pendingRequests.has(id)) {
        violations.push({
          line,
          rule: "mcp-correlation",
          message: `duplicate in-flight request id=${JSON.stringify(id)} (first seen at line ${pendingRequests.get(id)})`,
        });
      }
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

// ── Main static validation ────────────────────────────────────────

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
    validateMcpCorrelation(entries, violations);
  }

  return {
    file,
    entries: entries.length,
    violations,
    pass: violations.length === 0,
  };
}

// ── Mock-driver replay ────────────────────────────────────────────
//
// Spawns the actual mock-session-worker as a Bun Worker, feeds it the
// recorded daemon→worker messages, collects the worker→daemon output,
// and structurally compares against the recording.
//
// IGNORED FIELDS during structural comparison (exhaustive list):
//   - t             : timestamps differ across runs
//   - sessionId     : mock worker generates fresh UUIDs each run
//   - session.sessionId : nested variant inside db:upsert
//   - id            : MCP JSON-RPC ids are auto-incremented by the SDK
//   - seq           : event buffer sequence numbers
//   - requestId     : mock worker auto-generates permission request ids
//   - createdAt     : session creation timestamp
//   - supported_protocol_version : may differ across builds
//   - daemonId      : daemon instance identifier
//
// Additionally, UUID values embedded in JSON-encoded string fields (e.g.
// tool response `text` containing `{"sessionId":"..."}`) are normalized
// to a placeholder. This handles the mock worker generating fresh UUIDs
// inside serialized payloads.
//
// Everything else must match structurally. Adding a field to this list
// requires updating this comment and the IGNORED_COMPARISON_KEYS set.

const IGNORED_COMPARISON_KEYS = new Set([
  "t",
  "sessionId",
  "id",
  "seq",
  "requestId",
  "createdAt",
  "supported_protocol_version",
  "daemonId",
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_PLACEHOLDER = "<UUID>";

function normalizeForComparison(obj: unknown): unknown {
  if (typeof obj === "string") return obj.replace(UUID_RE, UUID_PLACEHOLDER);
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (IGNORED_COMPARISON_KEYS.has(key)) continue;
    result[key] = normalizeForComparison(value);
  }
  return result;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForComparison(a)) === JSON.stringify(normalizeForComparison(b));
}

const MOCK_WORKER_PATH = join(import.meta.dir, "../../packages/daemon/src/mock-session-worker.ts");

export interface ReplayThroughMockOptions {
  workerPath?: string;
  timeoutMs?: number;
}

export async function replayThroughMock(
  entries: RecordingEntry[],
  file: string,
  opts?: ReplayThroughMockOptions,
): Promise<MockReplayReport> {
  const violations: ReplayViolation[] = [];
  const workerFile = opts?.workerPath ?? MOCK_WORKER_PATH;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  const daemonEntries = entries.filter((e) => e.dir === "daemon->worker");
  const expectedWorkerEntries = entries.filter((e) => e.dir === "worker->daemon");

  if (daemonEntries.length === 0) {
    return {
      file,
      entries: entries.length,
      violations: [{ line: 0, rule: "mock-replay", message: "no daemon→worker messages to replay" }],
      pass: false,
      expectedWorkerMessages: 0,
      actualWorkerMessages: 0,
    };
  }

  const initEntry = daemonEntries[0];
  if (getType(initEntry.payload) !== "init") {
    return {
      file,
      entries: entries.length,
      violations: [{ line: 1, rule: "mock-replay", message: "first daemon→worker message must be init" }],
      pass: false,
      expectedWorkerMessages: expectedWorkerEntries.length,
      actualWorkerMessages: 0,
    };
  }

  const collectedMessages: unknown[] = [];
  const worker = new Worker(workerFile);

  try {
    // Phase 1: send init, wait for ready/error
    const readyResult = await new Promise<"ready" | "error">((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("mock worker init timeout"));
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        collectedMessages.push(data);
        const type = getType(data);
        if (type === "ready") {
          clearTimeout(timer);
          resolve("ready");
        } else if (type === "error") {
          clearTimeout(timer);
          resolve("error");
        }
      };

      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timer);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        reject(new Error(`mock worker error: ${msg}`));
      };

      worker.postMessage(initEntry.payload);
    });

    if (readyResult === "error") {
      // Worker reported error — check if recording expected error too
      const firstExpected = expectedWorkerEntries[0];
      if (firstExpected && getType(firstExpected.payload) === "error") {
        return {
          file,
          entries: entries.length,
          violations,
          pass: violations.length === 0,
          expectedWorkerMessages: expectedWorkerEntries.length,
          actualWorkerMessages: collectedMessages.length,
        };
      }
      violations.push({
        line: 0,
        rule: "mock-replay",
        message: "mock worker returned error but recording expected ready",
      });
      return {
        file,
        entries: entries.length,
        violations,
        pass: false,
        expectedWorkerMessages: expectedWorkerEntries.length,
        actualWorkerMessages: collectedMessages.length,
      };
    }

    // Phase 2: feed remaining daemon→worker messages (MCP JSON-RPC + control)
    // and collect all worker→daemon responses.
    //
    // The mock worker processes messages asynchronously (runScript spawns in
    // background). We send all daemon→worker messages then wait for the worker
    // to quiesce — detected when no new messages arrive within a settle window.
    const remainingDaemon = daemonEntries.slice(1);

    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const settlePromise = new Promise<void>((resolve) => {
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const SETTLE_MS = 500;

      const doResolve = () => {
        clearTimeout(overallTimer);
        resolve();
      };

      const resetSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(doResolve, SETTLE_MS);
      };

      overallTimer = setTimeout(() => {
        if (settleTimer) clearTimeout(settleTimer);
        doResolve();
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        collectedMessages.push(event.data);
        resetSettle();
      };

      resetSettle();
    });

    for (const entry of remainingDaemon) {
      worker.postMessage(entry.payload);
    }

    await settlePromise;

    // Phase 3: compare collected worker→daemon messages against expected
    if (collectedMessages.length !== expectedWorkerEntries.length) {
      violations.push({
        line: 0,
        rule: "mock-replay-count",
        message: `expected ${expectedWorkerEntries.length} worker→daemon messages, got ${collectedMessages.length}`,
      });
    }

    const compareLen = Math.min(collectedMessages.length, expectedWorkerEntries.length);
    for (let i = 0; i < compareLen; i++) {
      const actual = collectedMessages[i];
      const expected = expectedWorkerEntries[i];
      const recordingLine = entries.indexOf(expected) + 1;

      if (!structurallyEqual(actual, expected.payload)) {
        violations.push({
          line: recordingLine,
          rule: "mock-replay-mismatch",
          message: `worker message ${i + 1} differs: expected ${JSON.stringify(normalizeForComparison(expected.payload))}, got ${JSON.stringify(normalizeForComparison(actual))}`,
        });
      }
    }
  } finally {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  return {
    file,
    entries: entries.length,
    violations,
    pass: violations.length === 0,
    expectedWorkerMessages: expectedWorkerEntries.length,
    actualWorkerMessages: collectedMessages.length,
  };
}

// ── NDJSON parsing ────────────────────────────────────────────────

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
