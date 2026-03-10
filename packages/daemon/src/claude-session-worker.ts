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
 *   { type: "db:upsert", session: { sessionId, pid?, state?, model?, cwd?, worktree? } }
 *   { type: "db:state", sessionId, state }
 *   { type: "db:cost", sessionId, cost, tokens }
 *   { type: "db:end", sessionId }
 */

import { generateSpanId, resolveModelName } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SAFE_TOOLS, type PermissionRule, type PermissionStrategy } from "./claude-session/permission-router";
import type { SessionEvent } from "./claude-session/session-state";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import { ClaudeWsServer, type WaitResult, WaitTimeoutError } from "./claude-session/ws-server";
import { WorkerServerTransport } from "./worker-transport";

// ── Control messages ──

interface InitMessage {
  type: "init";
  daemonId?: string;
  port?: number;
}

interface ToolsChangedMessage {
  type: "tools_changed";
}

type ControlMessage = InitMessage | ToolsChangedMessage;

function isControlMessage(data: unknown): data is ControlMessage {
  return typeof data === "object" && data !== null && "type" in data && !("jsonrpc" in data);
}

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
        return handleSessionList(server);
      case "claude_session_status":
        return handleSessionStatus(server, args);
      case "claude_interrupt":
        return handleInterrupt(server, args);
      case "claude_bye":
        return handleBye(server, args);
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
    });

    // Post DB upsert
    self.postMessage({
      type: "db:upsert",
      session: {
        sessionId,
        state: "connecting",
        cwd: args.cwd as string | undefined,
        worktree: args.worktree as string | undefined,
      },
    });

    const pid = server.spawnClaude(sessionId);

    // Update DB with PID
    self.postMessage({
      type: "db:upsert",
      session: { sessionId, pid },
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

function handleSessionList(server: ClaudeWsServer): { content: Array<{ type: "text"; text: string }> } {
  const sessions = server.listSessions();
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

function handleBye(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const { worktree, cwd } = server.bye(args.sessionId as string);
  return { content: [{ type: "text", text: JSON.stringify({ ended: true, worktree, cwd }) }] };
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

  // Cursor-based path: use waitForEventsSince (errors propagate — no session-list fallback)
  if (afterSeq !== undefined) {
    const result: WaitResult = await server.waitForEventsSince(sessionId, afterSeq, timeoutMs);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  // Legacy path: single-event wait
  try {
    const event = await server.waitForEvent(sessionId, timeoutMs);
    return {
      content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    };
  } catch (err) {
    if (err instanceof WaitTimeoutError) {
      // On timeout, fall back to session list instead of erroring
      return handleSessionList(server);
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

async function startServer(preferredPort?: number): Promise<void> {
  // Start WebSocket server
  wsServer = new ClaudeWsServer();
  const port = wsServer.start(preferredPort);
  wsServer.onSessionEvent = forwardSessionEvent;

  // Report port to main thread
  self.postMessage({ type: "ready", port });

  // Start MCP Server
  mcpServer = new Server({ name: "_claude", version: "0.1.0" }, { capabilities: { tools: {} } });

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
    daemonId = data.daemonId;
    workerId = generateSpanId();
    await startServer(data.port);
  }
};
