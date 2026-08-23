/**
 * Bun Worker hosting Codex session management via MCP Server.
 *
 * Unlike the Claude worker which hosts a WebSocket server for external
 * SDK connections, this worker manages CodexSession instances directly,
 * each spawning a `codex app-server` child process.
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts MCP Server, responds: { type: "ready" }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses + DB event messages back
 *
 * DB event messages (worker → parent) for SQLite persistence:
 *   { type: "db:upsert", session: { sessionId, pid?, state?, model?, cwd?, worktree? } }
 *   { type: "db:state", sessionId, state }
 *   { type: "db:cost", sessionId, cost, tokens }
 *   { type: "db:end", sessionId }
 */

import { CodexSession, type CodexSessionConfig } from "@mcp-cli/codex";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentSessionEvent,
  CODEX_SERVER_NAME,
  DEFAULT_TIMEOUT_MS,
  NO_DOMAIN_ID,
  domainFilterArg,
  matchesDomain,
} from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CODEX_TOOLS } from "./codex-session/tools";
import { safeSetTimeout } from "./safe-timers";
import { createIsControlMessage } from "./worker-control-message";
import { WorkerServerTransport } from "./worker-transport";

// ── Control messages ──

interface InitMessage {
  type: "init";
  daemonId?: string;
  protocol_version?: number;
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

/** Active sessions indexed by session ID. */
const sessions = new Map<string, CodexSession>();

// ── afterSeq event buffer ──

interface BufferedEvent {
  seq: number;
  sessionId: string;
  event: AgentSessionEvent;
  /**
   * Domain of the session that emitted this, captured HERE, at buffer time (#3039).
   *
   * Deliberately not re-derived from the live `sessions` map when the buffer is read:
   * `forwardSessionEvent` deletes the map entry on `session:ended`, and the buffer
   * outlives the map. Re-deriving made a domain-scoped `wait --after <seq>` lose its
   * OWN domain's events the moment the session ended — the caller was standing in the
   * right domain and still got `[]`, indistinguishable from "nothing ran".
   * `ws-server.ts:3313` snapshots the session onto the event for the same reason.
   */
  domainId: number;
}

const MAX_EVENT_BUFFER = 200;
let nextSeq = 1;
const eventBuffer: BufferedEvent[] = [];

/** Resolvers waiting for events after a specific sequence number. */
const afterSeqWaiters: Array<{
  sessionId: string | null;
  afterSeq: number;
  /** Daemon-resolved domain the waiter is scoped to; undefined = any domain (#3039). */
  domainId: number | undefined;
  resolve: (entry: BufferedEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

function bufferEvent(sessionId: string, event: AgentSessionEvent): void {
  // Read the domain while the session is still in the map — this is the last moment
  // it is knowable for an event that ends the session.
  const domainId = sessions.get(sessionId)?.getInfo().domainId ?? NO_DOMAIN_ID;
  const entry: BufferedEvent = { seq: nextSeq++, sessionId, event, domainId };
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENT_BUFFER) {
    eventBuffer.shift();
  }

  // Resolve any afterSeq waiters that match
  for (let i = afterSeqWaiters.length - 1; i >= 0; i--) {
    const w = afterSeqWaiters[i];
    if (
      entry.seq > w.afterSeq &&
      (w.sessionId === null || w.sessionId === sessionId) &&
      matchesDomain(entry, w.domainId)
    ) {
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
        session: {
          sessionId,
          state: "init",
          model: event.model,
          cwd: event.cwd,
        },
      });
      self.postMessage({
        type: "metrics:inc",
        name: "codex_sessions_total",
        labels: { outcome: "started" },
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
      self.postMessage({
        type: "db:cost",
        sessionId,
        cost: event.cost ?? 0,
        tokens: 0,
      });
      self.postMessage({ type: "db:state", sessionId, state: "idle" });
      break;
    case "session:permission_request":
      self.postMessage({ type: "db:state", sessionId, state: "waiting_permission" });
      self.postMessage({
        type: "metrics:inc",
        name: "codex_approval_total",
        labels: { type: event.request.toolName, decision: "pending" },
      });
      break;
    case "session:ended":
      sessions.delete(sessionId);
      self.postMessage({ type: "db:end", sessionId });
      self.postMessage({
        type: "metrics:inc",
        name: "codex_sessions_total",
        labels: { outcome: "ended" },
      });
      break;
    case "session:disconnected":
      self.postMessage({ type: "db:disconnected", sessionId, reason: event.reason });
      break;
  }
}

// ── Tool handlers ──

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case "codex_prompt":
        return await handlePrompt(args);
      case "codex_session_list":
        return handleSessionList(args);
      case "codex_session_status":
        return handleSessionStatus(args);
      case "codex_interrupt":
        return await handleInterrupt(args);
      case "codex_bye":
        return handleBye(args);
      case "codex_transcript":
        return handleTranscript(args);
      case "codex_wait":
        return await handleWait(args);
      case "codex_approve":
        return handleApprove(args);
      case "codex_deny":
        return handleDeny(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

async function handlePrompt(args: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const prompt = args.prompt as string;
  const timeoutMs = (args.timeout as number) ?? DEFAULT_TIMEOUT_MS;
  let sessionId = args.sessionId as string | undefined;

  if (sessionId) {
    // Follow-up prompt to existing session
    const session = sessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
    }
    await session.send(prompt);
  } else {
    // New session
    sessionId = crypto.randomUUID();
    const cwd = (args.cwd as string) ?? process.cwd();

    const config: CodexSessionConfig = {
      cwd,
      prompt,
      model: args.model as string | undefined,
      sandbox: (args.sandbox as "read-only" | "danger-full-access") ?? "read-only",
      approvalPolicy: (args.approvalPolicy as CodexSessionConfig["approvalPolicy"]) ?? "on-request",
      allowedTools: args.allowedTools as string[] | undefined,
      disallowedTools: args.disallowedTools as string[] | undefined,
      worktree: args.worktree as string | undefined,
      repoRoot: args.repoRoot as string | undefined,
      // Resolved daemon-side (#3039); this worker cannot open the domains table.
      domainId: typeof args.domainId === "number" ? args.domainId : NO_DOMAIN_ID,
    };

    const sid = sessionId;
    const session = new CodexSession(sid, config, (event) => forwardSessionEvent(sid, event));
    sessions.set(sessionId, session);

    // Post initial DB upsert
    self.postMessage({
      type: "db:upsert",
      session: {
        sessionId,
        state: "connecting",
        cwd,
        domainId: config.domainId,
        worktree: config.worktree,
        // Forwarded to match the acp and opencode workers, which both send it. Codex
        // alone dropped it, so a `mcx agent codex spawn --worktree <name>` session
        // landed with worktree set and repo_root NULL — the one row shape that made
        // the old `repo_root ?? worktree ?? cwd` chain resolve to nothing (#3169 R7).
        repoRoot: config.repoRoot,
      },
    });

    self.postMessage({
      type: "metrics:inc",
      name: "codex_process_spawn_total",
      labels: { outcome: "attempt" },
    });

    try {
      await session.start();

      // Update DB with PID from the underlying process
      const info = session.getInfo();
      if (info.processAlive) {
        // Access the internal proc's PID — getInfo() doesn't expose it directly,
        // but we need it for pruneDeadSessions. We'll use a minimal check.
        self.postMessage({
          type: "metrics:inc",
          name: "codex_process_spawn_total",
          labels: { outcome: "success" },
        });
      }
    } catch (err) {
      sessions.delete(sessionId);
      self.postMessage({ type: "db:end", sessionId });
      self.postMessage({
        type: "metrics:inc",
        name: "codex_process_spawn_total",
        labels: { outcome: "failure" },
      });
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Failed to start Codex session: ${message}` }], isError: true };
    }
  }

  const shouldWait = (args.wait as boolean) ?? false;

  if (!shouldWait) {
    return {
      content: [{ type: "text", text: JSON.stringify({ sessionId }) }],
    };
  }

  // Block until next actionable event (result, error, permission request, or ended).
  // Using waitForEvent instead of waitForResult so that permission_request events
  // surface to the caller — otherwise on-request approval policy deadlocks.
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Session ${sessionId} already ended` }], isError: true };
  }

  const startTime = Date.now();
  const event = await session.waitForEvent(timeoutMs);
  const durationS = (Date.now() - startTime) / 1000;
  self.postMessage({
    type: "metrics:observe",
    name: "codex_turn_duration_seconds",
    value: durationS,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    isError: event.type === "session:error",
  };
}

function handleSessionList(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  // The daemon resolved `domainId` before these args crossed the worker boundary
  // (#3039); absent means the caller is in no domain, so nothing is filtered out.
  const domainId = domainFilterArg(args);
  const list = [...sessions.values()].map((s) => s.getInfo()).filter((s) => matchesDomain(s, domainId));
  return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

function handleSessionStatus(args: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(session.getInfo(), null, 2) }] };
}

async function handleInterrupt(args: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  await session.interrupt();
  return { content: [{ type: "text", text: JSON.stringify({ interrupted: true }) }] };
}

function handleBye(args: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  const info = session.getInfo();
  session.terminate();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ended: true,
          worktree: info.worktree,
          cwd: info.cwd,
          repoRoot: info.repoRoot,
        }),
      },
    ],
  };
}

function handleTranscript(args: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const sessionId = args.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  const limit = (args.limit as number) ?? 50;
  const transcript = session.getTranscript().slice(-limit);
  return { content: [{ type: "text", text: JSON.stringify(transcript, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const sessionId = args.sessionId as string | undefined;
  const timeoutMs = (args.timeout as number) ?? DEFAULT_TIMEOUT_MS;
  const afterSeq = args.afterSeq as number | undefined;
  // Resolved by the daemon before these args crossed the worker boundary (#3039).
  // `session_list` has honoured this since the start; `wait` used to accept it,
  // advertise it in the tool schema, and then ignore it — so a scoped wait woke on
  // another domain's session and its timeout fallback dumped every domain's list.
  const domainId = domainFilterArg(args);
  const inDomain = (info: { domainId: number }) => matchesDomain(info, domainId);

  // afterSeq cursor: check buffer first, then block until a new event arrives
  if (afterSeq !== undefined) {
    // Check buffer for events past the cursor
    const buffered = eventBuffer.filter(
      (e) => e.seq > afterSeq && (sessionId == null || e.sessionId === sessionId) && matchesDomain(e, domainId),
    );
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

    // No buffered events — block until one arrives
    const entry = await new Promise<BufferedEvent>((resolve, reject) => {
      const timer = safeSetTimeout(() => {
        const idx = afterSeqWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) afterSeqWaiters.splice(idx, 1);
        // On timeout, return current session list as fallback
        const list = [...sessions.values()].map((s) => s.getInfo()).filter(inDomain);
        reject({ timeout: true, sessions: list });
      }, timeoutMs);
      afterSeqWaiters.push({ sessionId: sessionId ?? null, afterSeq, domainId, resolve, timer });
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
        {
          type: "text",
          text: JSON.stringify({ ...entry.event, seq: entry.seq, sessionId: entry.sessionId }, null, 2),
        },
      ],
    };
  }

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
    }
    const event = await session.waitForEvent(timeoutMs);
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  }

  // Wait for any session IN THE CALLER'S DOMAIN. Racing every session was the bug:
  // an orchestrator blocking here read a completion for a session it does not own.
  const scoped = [...sessions.values()].filter((s) => inDomain(s.getInfo()));
  if (scoped.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify([]) }] };
  }

  const waiters = scoped.map((s) => s.waitForEvent(timeoutMs));
  try {
    const event = await Promise.race(waiters);
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  } finally {
    // Cancel losing waiters to prevent timer/reference leaks
    for (const p of waiters) {
      if (typeof p.cancel === "function") p.cancel();
      p.catch(() => {});
    }
  }
}

function handleApprove(args: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const sessionId = args.sessionId as string;
  const requestId = args.requestId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  session.approve(requestId);
  self.postMessage({
    type: "metrics:inc",
    name: "codex_approval_total",
    labels: { type: "manual", decision: "approved" },
  });
  return { content: [{ type: "text", text: JSON.stringify({ approved: true }) }] };
}

function handleDeny(args: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const sessionId = args.sessionId as string;
  const requestId = args.requestId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
  }
  session.deny(requestId);
  self.postMessage({
    type: "metrics:inc",
    name: "codex_approval_total",
    labels: { type: "manual", decision: "denied" },
  });
  return { content: [{ type: "text", text: JSON.stringify({ denied: true }) }] };
}

// ── Server startup ──

async function startServer(): Promise<void> {
  mcpServer = new Server({ name: CODEX_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CODEX_TOOLS.map((t) => ({
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

  // Wrap self.onmessage to intercept control messages
  const transportHandler = self.onmessage;
  self.onmessage = async (event: MessageEvent) => {
    const data = event.data;
    if (isControlMessage(data)) {
      if (data.type === "tools_changed") {
        await mcpServer?.notification({ method: "notifications/tools/list_changed" });
      }
      return;
    }
    // Forward JSON-RPC messages to the transport
    transportHandler?.call(self, event);
  };
}

// ── Initial message handler ──

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (isControlMessage(data) && data.type === "init") {
    try {
      await startServer();
      self.postMessage({ type: "ready", supported_protocol_version: AGENT_PROTOCOL_VERSION });
    } catch (err) {
      mcpServer = null;
      transport = null;
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", message });
    }
  }
};
