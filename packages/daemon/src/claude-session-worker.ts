/**
 * Bun Worker hosting the Claude Code session WebSocket server + MCP Server.
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts WS server + MCP Server, responds: { type: "ready", port }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses + DB event messages back
 *
 * DB event messages (worker → parent) for SQLite persistence:
 *   { type: "db:upsert", session: { sessionId, pid?, pidStartTime?, state?, model?, cwd?, worktree? } }
 *   { type: "db:state", sessionId, state }
 *   { type: "db:cost", sessionId, cost, tokens }
 *   { type: "db:end", sessionId }
 */

import { generateSpanId, resolveModelName, silentLogger } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CLAUDE_SERVER_NAME } from "./claude-server";
import { DEFAULT_SAFE_TOOLS, type PermissionRule, type PermissionStrategy } from "./claude-session/permission-router";
import type { SessionEvent } from "./claude-session/session-state";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import { ClaudeWsServer, type WaitResult, WaitTimeoutError } from "./claude-session/ws-server";
import { getProcessStartTime } from "./process-identity";
import { createIsControlMessage } from "./worker-control-message";
import { WorkerServerTransport } from "./worker-transport";

// ── Control messages ──

interface InitMessage {
  type: "init";
  daemonId?: string;
  wsPort?: number;
  /** Suppress worker-side console logging (used in tests). */
  quiet?: boolean;
}

interface ToolsChangedMessage {
  type: "tools_changed";
}

interface RestoreSessionsMessage {
  type: "restore_sessions";
  sessions: Array<{
    sessionId: string;
    pid: number | null;
    pidStartTime?: number | null;
    state: string;
    model: string | null;
    cwd: string | null;
    worktree: string | null;
    totalCost: number;
    totalTokens: number;
  }>;
}

type ControlMessage = InitMessage | ToolsChangedMessage | RestoreSessionsMessage;

const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set<ControlMessage["type"]>([
  "init",
  "tools_changed",
  "restore_sessions",
]);
const isControlMessage = createIsControlMessage<ControlMessage>(CONTROL_MESSAGE_TYPES);

// ── Worker globals ──

declare const self: Worker;

let wsServer: ClaudeWsServer | null = null;
let mcpServer: Server | null = null;
let transport: WorkerServerTransport | null = null;

// Trace context — set on init, stable for worker lifetime
let daemonId: string | undefined;
let workerId: string | undefined;

// ── Tool handlers ──

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!wsServer) {
    return { content: [{ type: "text", text: "Claude session server not initialized" }], isError: true };
  }

  const server = wsServer;
  try {
    switch (name) {
      case "claude_prompt":
        return await handlePrompt(server, args);
      case "claude_session_list":
        return handleSessionList(server, args);
      case "claude_session_status":
        return handleSessionStatus(server, args);
      case "claude_interrupt":
        return handleInterrupt(server, args);
      case "claude_bye":
        return await handleBye(server, args);
      case "claude_transcript":
        return handleTranscript(server, args);
      case "claude_wait":
        return await handleWait(server, args);
      case "claude_approve":
        return handleApprove(server, args);
      case "claude_deny":
        return handleDeny(server, args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

async function handlePrompt(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const prompt = args.prompt as string;
  const timeoutMs = (args.timeout as number) ?? 300_000;

  let sessionId = args.sessionId as string | undefined;

  if (sessionId) {
    // Follow-up prompt to existing session
    server.sendPrompt(sessionId, prompt);
  } else {
    // New session
    if (args.worktree && args.resumeSessionId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: worktree and resumeSessionId cannot both be set — a new worktree creates a fresh directory, which conflicts with restoring conversation history from an existing session",
          },
        ],
        isError: true,
      };
    }
    sessionId = crypto.randomUUID();
    const permissionMode = (args.permissionMode as PermissionStrategy) ?? "rules";
    const allowedTools = (args.allowedTools as string[]) ?? undefined;
    const effectiveTools = permissionMode === "rules" ? (allowedTools ?? DEFAULT_SAFE_TOOLS) : undefined;
    const rules: PermissionRule[] | undefined = effectiveTools
      ? effectiveTools.map((tool) => ({ tool, action: "allow" as const }))
      : undefined;

    server.prepareSession(sessionId, {
      prompt,
      cwd: args.cwd as string | undefined,
      permissionStrategy: permissionMode,
      permissionRules: rules,
      allowedTools,
      worktree: args.worktree as string | undefined,
      model: args.model ? resolveModelName(args.model as string) : undefined,
      resumeSessionId: args.resumeSessionId as string | undefined,
      repoRoot: args.repoRoot as string | undefined,
    });

    // Post DB upsert
    self.postMessage({
      type: "db:upsert",
      session: {
        sessionId,
        state: "connecting",
        cwd: args.cwd as string | undefined,
        worktree: args.worktree as string | undefined,
        repoRoot: args.repoRoot as string | undefined,
      },
    });

    const pid = server.spawnClaude(sessionId);

    // Capture pidStartTime here in the worker thread (off the main event loop)
    // so the parent doesn't need to do a blocking ps(1) call per session.
    const pidStartTime = getProcessStartTime(pid);

    // Update DB with PID and start time
    self.postMessage({
      type: "db:upsert",
      session: { sessionId, pid, pidStartTime },
    });
  }

  const shouldWait = (args.wait as boolean) ?? false;

  if (!shouldWait) {
    return {
      content: [{ type: "text", text: JSON.stringify({ sessionId, seq: server.currentSeq }) }],
    };
  }

  // Block until result
  const result = await server.waitForResult(sessionId, timeoutMs);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
}

function handleSessionList(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  let sessions = server.listSessions();
  const repoRoot = args.repoRoot as string | undefined;
  if (repoRoot) {
    sessions = sessions.filter((s) => !s.repoRoot || s.repoRoot === repoRoot);
  }
  return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
}

function handleSessionStatus(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const status = server.getStatus(args.sessionId as string);
  return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
}

function handleInterrupt(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  server.interrupt(args.sessionId as string);
  return { content: [{ type: "text", text: JSON.stringify({ interrupted: true }) }] };
}

async function handleBye(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const { worktree, cwd, repoRoot } = await server.bye(args.sessionId as string);
  return { content: [{ type: "text", text: JSON.stringify({ ended: true, worktree, cwd, repoRoot }) }] };
}

function handleTranscript(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const limit = (args.limit as number) ?? 50;
  const transcript = server.getTranscript(args.sessionId as string, limit);
  return { content: [{ type: "text", text: JSON.stringify(transcript, null, 2) }] };
}

function handleApprove(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  server.respondToPermission(args.sessionId as string, args.requestId as string, true);
  return { content: [{ type: "text", text: JSON.stringify({ approved: true }) }] };
}

function handleDeny(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const message = (args.message as string) ?? "Denied by user via mcpctl";
  server.respondToPermission(args.sessionId as string, args.requestId as string, false, message);
  return { content: [{ type: "text", text: JSON.stringify({ denied: true }) }] };
}

async function handleWait(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const sessionId = (args.sessionId as string | undefined) ?? null;
  const timeoutMs = (args.timeout as number) ?? 300_000;
  const afterSeq = args.afterSeq as number | undefined;
  const repoRoot = args.repoRoot as string | undefined;

  // Cursor-based path: use waitForEventsSince (errors propagate — no session-list fallback)
  if (afterSeq !== undefined) {
    const result: WaitResult = await server.waitForEventsSince(sessionId, afterSeq, timeoutMs);
    if (repoRoot) {
      result.events = result.events.filter((e) => !e.session?.repoRoot || e.session.repoRoot === repoRoot);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  // Legacy path: unified { event?, sessions } shape
  try {
    const event = await server.waitForEvent(sessionId, timeoutMs);
    // Filter single event by repoRoot — if mismatched, return empty array (same as timeout)
    if (repoRoot && event.session?.repoRoot && event.session.repoRoot !== repoRoot) {
      return handleSessionList(server, { repoRoot });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ event, sessions: server.listSessions() }, null, 2) }],
    };
  } catch (err) {
    if (err instanceof WaitTimeoutError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ sessions: server.listSessions() }, null, 2) }],
      };
    }
    throw err;
  }
}

// ── Session event → DB message forwarding ──

function forwardSessionEvent(sessionId: string, event: SessionEvent): void {
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
      break;
    case "session:result":
      self.postMessage({ type: "db:cost", sessionId, cost: event.cost, tokens: event.tokens });
      self.postMessage({ type: "db:state", sessionId, state: "idle" });
      break;
    case "session:error":
      self.postMessage({ type: "db:cost", sessionId, cost: event.cost, tokens: 0 });
      self.postMessage({ type: "db:state", sessionId, state: "idle" });
      break;
    case "session:disconnected":
      self.postMessage({ type: "db:disconnected", sessionId, reason: event.reason });
      break;
    case "session:ended":
      self.postMessage({ type: "db:end", sessionId });
      break;
    case "session:cleared":
      self.postMessage({ type: "db:state", sessionId, state: "connecting" });
      break;
    case "session:model_changed":
      self.postMessage({ type: "db:upsert", session: { sessionId, model: event.model } });
      break;
  }
}

// ── Server startup ──

async function startServer(wsPort?: number, quiet?: boolean): Promise<number> {
  // Start WebSocket server
  wsServer = new ClaudeWsServer({ logger: quiet ? silentLogger : undefined });
  const port = await wsServer.start(wsPort);
  wsServer.onSessionEvent = forwardSessionEvent;

  // Start MCP Server
  mcpServer = new Server({ name: CLAUDE_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CLAUDE_TOOLS.map((t) => ({
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
      } else if (data.type === "restore_sessions" && wsServer) {
        wsServer.restoreSessions(data.sessions);
      }
      return;
    }
    // Forward JSON-RPC messages to the transport
    transportHandler?.call(self, event);
  };

  return port;
}

// ── Initial message handler ──

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (isControlMessage(data) && data.type === "init") {
    daemonId = data.daemonId;
    workerId = generateSpanId();
    try {
      const port = await startServer(data.wsPort, data.quiet);
      self.postMessage({ type: "ready", port });
    } catch (err) {
      // Clean up partially-initialized resources
      await wsServer?.stop().catch(() => {});
      wsServer = null;
      mcpServer = null;
      transport = null;
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", message });
    }
  }
};
