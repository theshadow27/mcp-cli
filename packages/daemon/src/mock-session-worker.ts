/**
 * Bun Worker hosting mock session management via MCP Server.
 *
 * Unlike real agent workers, this worker manages sessions entirely in-process:
 * it reads a JSON script file and emits canned responses with configurable delays.
 * No external binary, no network, fully deterministic.
 *
 * Extended script format (discriminated union on `emit` or `wait_for`):
 *
 *   [
 *     {"emit": "init", "session_id": "..."},
 *     {"delay": 100, "emit": "response", "text": "Hello"},
 *     {"emit": "tool_call", "name": "Read", "args": {"path": "/tmp/foo"}},
 *     {"emit": "permission_request", "tool": "Write", "args": {}},
 *     {"wait_for": "approve", "timeout_ms": 1000},
 *     {"emit": "cost", "usd": 0.0012, "tokens_in": 100, "tokens_out": 50},
 *     {"emit": "result", "text": "done"},
 *     {"emit": "error", "message": "something broke"},
 *     {"emit": "disconnect", "reason": "network"},
 *     {"emit": "end"}
 *   ]
 *
 * Legacy format still supported: [{"delay": 100, "text": "Hello"}]
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts MCP Server, responds: { type: "ready" }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses + DB event messages back
 */

import { resolve } from "node:path";
import {
  type AgentPermissionRequest,
  type AgentSessionEvent,
  DEFAULT_TIMEOUT_MS,
  MOCK_SERVER_NAME,
} from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MOCK_TOOLS } from "./mock-session/tools";
import { safeSetTimeout } from "./safe-timers";
import { createIsControlMessage } from "./worker-control-message";
import { WorkerServerTransport } from "./worker-transport";

// ── Control messages ──

interface InitMessage {
  type: "init";
  daemonId?: string;
}

interface ToolsChangedMessage {
  type: "tools_changed";
}

type ControlMessage = InitMessage | ToolsChangedMessage;

const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set<ControlMessage["type"]>(["init", "tools_changed"]);
const isControlMessage = createIsControlMessage<ControlMessage>(CONTROL_MESSAGE_TYPES);

// ── Worker globals ──

declare const self: Worker;

let mcpServer: Server | null = null;
let transport: WorkerServerTransport | null = null;

// ── Script entry types (discriminated union) ──

interface EmitInit {
  emit: "init";
  session_id?: string;
  delay?: number;
}

interface EmitResponse {
  emit: "response";
  text: string;
  delay?: number;
}

interface EmitToolCall {
  emit: "tool_call";
  name: string;
  args?: Record<string, unknown>;
  delay?: number;
}

interface EmitPermissionRequest {
  emit: "permission_request";
  tool: string;
  args?: Record<string, unknown>;
  request_id?: string;
  delay?: number;
}

interface EmitCost {
  emit: "cost";
  usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  delay?: number;
}

interface EmitResult {
  emit: "result";
  text?: string;
  delay?: number;
}

interface EmitError {
  emit: "error";
  message?: string;
  messages?: string[];
  delay?: number;
}

interface EmitDisconnect {
  emit: "disconnect";
  reason?: string;
  delay?: number;
}

interface EmitEnd {
  emit: "end";
  delay?: number;
}

interface WaitForEntry {
  wait_for: "approve" | "deny";
  timeout_ms?: number;
}

interface LegacyEntry {
  delay: number;
  text: string;
}

type ScriptEntry =
  | EmitInit
  | EmitResponse
  | EmitToolCall
  | EmitPermissionRequest
  | EmitCost
  | EmitResult
  | EmitError
  | EmitDisconnect
  | EmitEnd
  | WaitForEntry
  | LegacyEntry;

// ── Session type ──

interface PermissionWaiter {
  requestId: string;
  promise: Promise<"approve" | "deny" | "timeout">;
  resolve: (verdict: "approve" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MockSession {
  sessionId: string;
  cwd: string;
  scriptPath: string;
  entries: ScriptEntry[];
  state: "running" | "idle" | "ended";
  interrupted: boolean;
  transcript: Array<{ role: string; text: string }>;
  createdAt: number;
  pendingPermissions: Map<string, PermissionWaiter>;
  totalCost: number;
  totalTokens: number;
  lastResultText: string | null;
  /** Resolves when the script finishes or is interrupted. */
  done: Promise<void>;
  resolveDone: () => void;
}

const sessions = new Map<string, MockSession>();

// ── afterSeq event buffer ──

interface BufferedEvent {
  seq: number;
  sessionId: string;
  event: AgentSessionEvent;
}

const MAX_EVENT_BUFFER = 200;
let nextSeq = 1;
const eventBuffer: BufferedEvent[] = [];

const afterSeqWaiters: Array<{
  sessionId: string | null;
  afterSeq: number;
  resolve: (entry: BufferedEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

function bufferEvent(sessionId: string, event: AgentSessionEvent): void {
  const entry: BufferedEvent = { seq: nextSeq++, sessionId, event };
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENT_BUFFER) {
    eventBuffer.shift();
  }

  for (let i = afterSeqWaiters.length - 1; i >= 0; i--) {
    const w = afterSeqWaiters[i];
    if (entry.seq > w.afterSeq && (w.sessionId === null || w.sessionId === sessionId)) {
      clearTimeout(w.timer);
      afterSeqWaiters.splice(i, 1);
      w.resolve(entry);
    }
  }
}

// ── Session event → DB message forwarding ──

function forwardSessionEvent(sessionId: string, event: AgentSessionEvent): void {
  bufferEvent(sessionId, event);
  switch (event.type) {
    case "session:init":
      self.postMessage({
        type: "db:upsert",
        session: { sessionId, state: "init", model: event.model, cwd: event.cwd },
      });
      break;
    case "session:permission_request":
      self.postMessage({ type: "db:state", sessionId, state: "waiting_permission" });
      break;
    case "session:result":
      self.postMessage({
        type: "db:cost",
        sessionId,
        cost: event.result.cost ?? 0,
        tokens: event.result.tokens,
      });
      self.postMessage({ type: "db:state", sessionId, state: "idle" });
      break;
    case "session:error":
      self.postMessage({ type: "db:state", sessionId, state: "idle" });
      break;
    case "session:ended":
      sessions.delete(sessionId);
      self.postMessage({ type: "db:end", sessionId });
      break;
    case "session:disconnected":
      self.postMessage({ type: "db:disconnected", sessionId, reason: event.reason });
      break;
  }
}

// ── Script execution ──

function isLegacyEntry(entry: ScriptEntry): entry is LegacyEntry {
  return "text" in entry && "delay" in entry && !("emit" in entry) && !("wait_for" in entry);
}

function isWaitForEntry(entry: ScriptEntry): entry is WaitForEntry {
  return "wait_for" in entry;
}

function getDelay(entry: ScriptEntry): number {
  if ("delay" in entry && typeof entry.delay === "number") return entry.delay;
  return 0;
}

async function applyDelay(session: MockSession, entry: ScriptEntry): Promise<boolean> {
  const delay = getDelay(entry);
  if (delay > 0) await Bun.sleep(delay);
  return !session.interrupted;
}

let nextRequestId = 1;

function emitInit(session: MockSession, sessionIdOverride?: string): void {
  forwardSessionEvent(session.sessionId, {
    type: "session:init",
    sessionId: sessionIdOverride ?? session.sessionId,
    provider: "mock",
    model: "mock",
    cwd: session.cwd,
  });
}

async function runScript(session: MockSession): Promise<void> {
  session.state = "running";
  self.postMessage({ type: "db:state", sessionId: session.sessionId, state: "active" });

  let emittedTerminal = false;

  // Auto-emit init unless the first entry is an explicit init
  const firstEntry = session.entries[0];
  const firstIsExplicitInit = firstEntry && "emit" in firstEntry && firstEntry.emit === "init";
  if (!firstIsExplicitInit) {
    emitInit(session);
  }

  for (let i = 0; i < session.entries.length; i++) {
    if (session.interrupted || emittedTerminal) break;

    const entry = session.entries[i];

    if (isLegacyEntry(entry)) {
      if (!(await applyDelay(session, entry))) break;
      session.transcript.push({ role: "assistant", text: entry.text });
      forwardSessionEvent(session.sessionId, { type: "session:response", text: entry.text });
      continue;
    }

    if (isWaitForEntry(entry)) {
      const lastPermission = [...session.pendingPermissions.values()].at(-1);
      if (!lastPermission) continue;

      const timeoutMs = entry.timeout_ms ?? 5000;
      const timeoutPromise = new Promise<"timeout">((res) => {
        lastPermission.timer = safeSetTimeout(() => res("timeout"), timeoutMs);
      });
      const verdict = await Promise.race([lastPermission.promise, timeoutPromise]);

      if (verdict === "timeout") {
        session.transcript.push({ role: "system", text: `permission timeout (expected ${entry.wait_for})` });
      } else {
        session.transcript.push({ role: "system", text: `permission ${verdict}` });
      }

      clearTimeout(lastPermission.timer);
      session.pendingPermissions.delete(lastPermission.requestId);
      self.postMessage({ type: "db:state", sessionId: session.sessionId, state: "active" });
      continue;
    }

    if (!(await applyDelay(session, entry))) break;

    switch (entry.emit) {
      case "init": {
        emitInit(session, entry.session_id);
        break;
      }

      case "response": {
        session.transcript.push({ role: "assistant", text: entry.text });
        forwardSessionEvent(session.sessionId, { type: "session:response", text: entry.text });
        break;
      }

      case "tool_call": {
        const text = `[tool_call] ${entry.name}(${JSON.stringify(entry.args ?? {})})`;
        session.transcript.push({ role: "assistant", text });
        forwardSessionEvent(session.sessionId, { type: "session:response", text });
        break;
      }

      case "permission_request": {
        const requestId = entry.request_id ?? `mock-perm-${nextRequestId++}`;
        const request: AgentPermissionRequest = {
          requestId,
          toolName: entry.tool,
          input: entry.args ?? {},
          inputSummary: `${entry.tool}(${JSON.stringify(entry.args ?? {})})`,
        };

        let waiterResolve: (verdict: "approve" | "deny") => void = () => {};
        const promise = new Promise<"approve" | "deny" | "timeout">((res) => {
          waiterResolve = (v) => res(v);
        });
        const waiter: PermissionWaiter = {
          requestId,
          promise,
          resolve: waiterResolve,
          timer: safeSetTimeout(() => {}, 0),
        };
        session.pendingPermissions.set(requestId, waiter);

        forwardSessionEvent(session.sessionId, { type: "session:permission_request", request });
        break;
      }

      case "cost": {
        const cost = entry.usd ?? 0;
        const tokens = (entry.tokens_in ?? 0) + (entry.tokens_out ?? 0);
        session.totalCost += cost;
        session.totalTokens += tokens;
        self.postMessage({ type: "db:cost", sessionId: session.sessionId, cost, tokens });
        break;
      }

      case "result": {
        emittedTerminal = true;
        session.state = "idle";
        session.lastResultText = entry.text ?? "Mock script completed";
        forwardSessionEvent(session.sessionId, {
          type: "session:result",
          result: {
            result: session.lastResultText,
            cost: session.totalCost,
            tokens: session.totalTokens,
            numTurns: 1,
          },
        });
        break;
      }

      case "error": {
        emittedTerminal = true;
        const errors = entry.messages ?? (entry.message ? [entry.message] : ["mock error"]);
        session.transcript.push({ role: "system", text: `error: ${errors.join("; ")}` });
        forwardSessionEvent(session.sessionId, { type: "session:error", errors, cost: session.totalCost });
        break;
      }

      case "disconnect": {
        emittedTerminal = true;
        const reason = entry.reason ?? "mock disconnect";
        forwardSessionEvent(session.sessionId, { type: "session:disconnected", reason });
        break;
      }

      case "end": {
        emittedTerminal = true;
        session.state = "ended";
        forwardSessionEvent(session.sessionId, { type: "session:ended" });
        break;
      }
    }
  }

  if (!emittedTerminal) {
    session.state = "idle";
    if (!session.interrupted) {
      session.lastResultText = "Mock script completed";
      forwardSessionEvent(session.sessionId, {
        type: "session:result",
        result: {
          result: session.lastResultText,
          cost: session.totalCost,
          tokens: session.totalTokens > 0 ? session.totalTokens : session.entries.length,
          numTurns: 1,
        },
      });
    }
  }

  for (const waiter of session.pendingPermissions.values()) {
    clearTimeout(waiter.timer);
  }
  session.pendingPermissions.clear();
  session.resolveDone();
}

// ── Tool handlers ──

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "mock_prompt":
        return await handlePrompt(args);
      case "mock_session_list":
        return handleSessionList();
      case "mock_session_status":
        return handleSessionStatus(args);
      case "mock_interrupt":
        return handleInterrupt(args);
      case "mock_bye":
        return handleBye(args);
      case "mock_transcript":
        return handleTranscript(args);
      case "mock_wait":
        return await handleWait(args);
      case "mock_approve":
        return handleApprove(args);
      case "mock_deny":
        return handleDeny(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

async function handlePrompt(args: Record<string, unknown>): Promise<ToolResult> {
  const prompt = args.prompt as string;
  let sessionId = args.sessionId as string | undefined;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
    }
    return { content: [{ type: "text", text: "Mock sessions do not support follow-up prompts" }], isError: true };
  }

  // New session — prompt is the JSON script file path
  sessionId = crypto.randomUUID();
  const cwd = (args.cwd as string) ?? process.cwd();
  const scriptPath = resolve(cwd, prompt);

  // Read and parse the script file
  let entries: ScriptEntry[];
  try {
    const raw = await Bun.file(scriptPath).text();
    entries = JSON.parse(raw) as ScriptEntry[];
    if (!Array.isArray(entries)) {
      return { content: [{ type: "text", text: `Script must be a JSON array: ${scriptPath}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Failed to read script ${scriptPath}: ${message}` }],
      isError: true,
    };
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const session: MockSession = {
    sessionId,
    cwd,
    scriptPath,
    entries,
    state: "running",
    interrupted: false,
    transcript: [{ role: "user", text: prompt }],
    createdAt: Date.now(),
    pendingPermissions: new Map(),
    totalCost: 0,
    totalTokens: 0,
    lastResultText: null,
    done,
    resolveDone,
  };
  sessions.set(sessionId, session);

  // Post initial DB upsert
  self.postMessage({
    type: "db:upsert",
    session: { sessionId, state: "connecting", cwd },
  });

  // Run script in background
  const scriptPromise = runScript(session);

  const shouldWait = (args.wait as boolean) ?? false;
  if (!shouldWait) {
    // Don't await — let it run in the background
    scriptPromise.catch((e) => console.warn("[mock-worker] background script rejected:", e));
    return { content: [{ type: "text", text: JSON.stringify({ sessionId }) }] };
  }

  // Wait for script to complete
  await scriptPromise;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          type: "session:result",
          sessionId,
          result: {
            result: session.lastResultText ?? "Mock script completed",
            cost: session.totalCost,
            tokens: session.totalTokens > 0 ? session.totalTokens : session.entries.length,
            numTurns: 1,
          },
        }),
      },
    ],
  };
}

function handleSessionList(): ToolResult {
  const list = [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    state: s.state,
    model: "mock",
    cwd: s.cwd,
    cost: 0,
    tokens: s.entries.length,
    createdAt: s.createdAt,
  }));
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

function handleSessionStatus(args: Record<string, unknown>): ToolResult {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          sessionId: session.sessionId,
          state: session.state,
          model: "mock",
          cwd: session.cwd,
          scriptPath: session.scriptPath,
          entriesTotal: session.entries.length,
          transcriptLength: session.transcript.length,
        }),
      },
    ],
  };
}

function handleInterrupt(args: Record<string, unknown>): ToolResult {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  session.interrupted = true;
  return { content: [{ type: "text", text: JSON.stringify({ interrupted: true }) }] };
}

function handleBye(args: Record<string, unknown>): ToolResult {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  session.interrupted = true;
  session.state = "ended";
  forwardSessionEvent(sessionId, { type: "session:ended" });
  return {
    content: [{ type: "text", text: JSON.stringify({ ended: true, cwd: session.cwd }) }],
  };
}

function handleTranscript(args: Record<string, unknown>): ToolResult {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  const limit = (args.limit as number) ?? 50;
  const transcript = session.transcript.slice(-limit);
  return { content: [{ type: "text", text: JSON.stringify(transcript, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = args.sessionId as string | undefined;
  const timeoutMs = (args.timeout as number) ?? DEFAULT_TIMEOUT_MS;
  const afterSeq = args.afterSeq as number | undefined;

  // afterSeq cursor: check buffer first, then block
  if (afterSeq !== undefined) {
    const buffered = eventBuffer.filter((e) => e.seq > afterSeq && (sessionId == null || e.sessionId === sessionId));
    if (buffered.length > 0) {
      const entry = buffered[0];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...entry.event, seq: entry.seq, sessionId: entry.sessionId }, null, 2),
          },
        ],
      };
    }

    const entry = await new Promise<BufferedEvent>((res, reject) => {
      const timer = safeSetTimeout(() => {
        const idx = afterSeqWaiters.findIndex((w) => w.resolve === res);
        if (idx !== -1) afterSeqWaiters.splice(idx, 1);
        const list = [...sessions.values()].map((s) => ({ sessionId: s.sessionId, state: s.state }));
        reject({ timeout: true, sessions: list });
      }, timeoutMs);
      afterSeqWaiters.push({ sessionId: sessionId ?? null, afterSeq, resolve: res, timer });
    }).catch((err) => {
      if (err && typeof err === "object" && "timeout" in err) {
        return err as { timeout: true; sessions: unknown[] };
      }
      throw err;
    });

    if ("timeout" in entry) {
      return { content: [{ type: "text", text: JSON.stringify(entry.sessions, null, 2) }] };
    }

    return {
      content: [
        { type: "text", text: JSON.stringify({ ...entry.event, seq: entry.seq, sessionId: entry.sessionId }, null, 2) },
      ],
    };
  }

  // Wait for a specific session's script to complete
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
    }
    if (session.state === "idle" || session.state === "ended") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              type: "session:result",
              sessionId,
              result: { cost: 0, tokens: session.entries.length, numTurns: 1 },
            }),
          },
        ],
      };
    }
    await Promise.race([session.done, Bun.sleep(timeoutMs)]);
    // Re-read state after await — TS narrowing doesn't track mutation across await
    const currentState: string = session.state;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: currentState === "idle" ? "session:result" : "timeout",
            sessionId,
            result: { result: "Mock script completed", cost: 0, tokens: session.entries.length, numTurns: 1 },
          }),
        },
      ],
    };
  }

  // Wait for any session
  if (sessions.size === 0) {
    return { content: [{ type: "text", text: JSON.stringify([]) }] };
  }

  const waiters = [...sessions.values()].map((s) => s.done);
  await Promise.race([...waiters, Bun.sleep(timeoutMs)]);
  const list = [...sessions.values()].map((s) => ({ sessionId: s.sessionId, state: s.state }));
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

function resolvePermission(args: Record<string, unknown>, verdict: "approve" | "deny"): ToolResult {
  const sessionId = args.sessionId as string;
  const requestId = args.requestId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  const waiter = session.pendingPermissions.get(requestId);
  if (!waiter) {
    const pending = [...session.pendingPermissions.keys()];
    return {
      content: [{ type: "text", text: `No pending permission ${requestId}. Pending: [${pending.join(", ")}]` }],
      isError: true,
    };
  }
  waiter.resolve(verdict);
  return { content: [{ type: "text", text: JSON.stringify({ [`${verdict}d`]: true, requestId }) }] };
}

function handleApprove(args: Record<string, unknown>): ToolResult {
  return resolvePermission(args, "approve");
}

function handleDeny(args: Record<string, unknown>): ToolResult {
  return resolvePermission(args, "deny");
}

// ── Server startup ──

async function startServer(): Promise<void> {
  mcpServer = new Server({ name: MOCK_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MOCK_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args ?? {});
  });

  transport = new WorkerServerTransport(self);
  await mcpServer.connect(transport);

  const transportHandler = self.onmessage;
  self.onmessage = async (event: MessageEvent) => {
    const data = event.data;
    if (isControlMessage(data)) {
      if (data.type === "tools_changed") {
        await mcpServer?.notification({ method: "notifications/tools/list_changed" });
      }
      return;
    }
    transportHandler?.call(self, event);
  };
}

// ── Initial message handler ──

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (isControlMessage(data) && data.type === "init") {
    try {
      await startServer();
      self.postMessage({ type: "ready" });
    } catch (err) {
      mcpServer = null;
      transport = null;
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", message });
    }
  }
};
