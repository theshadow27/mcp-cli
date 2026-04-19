/**
 * Bun Worker hosting mock session management via MCP Server.
 *
 * Unlike real agent workers, this worker manages sessions entirely in-process:
 * it reads a JSON script file and emits canned responses with configurable delays.
 * No external binary, no network, fully deterministic.
 *
 * Script format: [{ "delay": 100, "text": "Hello" }, { "delay": 0, "text": "Done" }]
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts MCP Server, responds: { type: "ready" }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses + DB event messages back
 */

import { resolve } from "node:path";
import { type AgentSessionEvent, DEFAULT_TIMEOUT_MS, MOCK_SERVER_NAME } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MOCK_TOOLS } from "./mock-session/tools";
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

// ── Script entry type ──

interface ScriptEntry {
  delay: number;
  text: string;
}

// ── Session type ──

interface MockSession {
  sessionId: string;
  cwd: string;
  scriptPath: string;
  entries: ScriptEntry[];
  state: "running" | "idle" | "ended";
  interrupted: boolean;
  transcript: Array<{ role: string; text: string }>;
  createdAt: number;
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

async function runScript(session: MockSession): Promise<void> {
  session.state = "running";
  self.postMessage({ type: "db:state", sessionId: session.sessionId, state: "active" });

  forwardSessionEvent(session.sessionId, {
    type: "session:init",
    sessionId: session.sessionId,
    provider: "mock",
    model: "mock",
    cwd: session.cwd,
  });

  for (let i = 0; i < session.entries.length; i++) {
    if (session.interrupted) break;

    const entry = session.entries[i];
    if (entry.delay > 0) {
      await Bun.sleep(entry.delay);
    }
    if (session.interrupted) break;

    session.transcript.push({ role: "assistant", text: entry.text });
    forwardSessionEvent(session.sessionId, {
      type: "session:response",
      text: entry.text,
    });
  }

  session.state = "idle";
  forwardSessionEvent(session.sessionId, {
    type: "session:result",
    result: {
      result: "Mock script completed",
      cost: 0,
      tokens: session.entries.length,
      numTurns: 1,
    },
  });
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
        return { content: [{ type: "text", text: "Mock sessions do not generate permission requests" }] };
      case "mock_deny":
        return { content: [{ type: "text", text: "Mock sessions do not generate permission requests" }] };
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
    scriptPromise.catch(() => {});
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
          result: { cost: 0, tokens: session.entries.length, numTurns: 1 },
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
      const timer = setTimeout(() => {
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
