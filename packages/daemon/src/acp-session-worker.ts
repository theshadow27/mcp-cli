/**
 * Bun Worker hosting ACP agent session management via MCP Server.
 *
 * Manages AcpSession instances, each spawning an ACP-compatible CLI
 * (e.g. `gh copilot --acp`, `gemini --acp`).
 *
 * Mirrors codex-session-worker.ts but for the ACP protocol.
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts MCP Server, responds: { type: "ready" }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses + DB event messages back
 */

import { AcpSession, type AcpSessionConfig } from "@mcp-cli/acp";
import { ACP_SERVER_NAME, type AgentSessionEvent } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ACP_TOOLS } from "./acp-session/tools";
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

/** Active sessions indexed by session ID. */
const sessions = new Map<string, AcpSession>();

// ── Session event → DB message forwarding ──

function forwardSessionEvent(sessionId: string, event: AgentSessionEvent): void {
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
        name: "acp_sessions_total",
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
        name: "acp_approval_total",
        labels: { type: event.request.toolName, decision: "pending" },
      });
      break;
    case "session:ended":
      sessions.delete(sessionId);
      self.postMessage({ type: "db:end", sessionId });
      self.postMessage({
        type: "metrics:inc",
        name: "acp_sessions_total",
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
      case "acp_prompt":
        return await handlePrompt(args);
      case "acp_session_list":
        return handleSessionList();
      case "acp_session_status":
        return handleSessionStatus(args);
      case "acp_interrupt":
        return await handleInterrupt(args);
      case "acp_bye":
        return handleBye(args);
      case "acp_transcript":
        return handleTranscript(args);
      case "acp_wait":
        return await handleWait(args);
      case "acp_approve":
        return handleApprove(args);
      case "acp_deny":
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
  const timeoutMs = (args.timeout as number) ?? 300_000;
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
    const agent = (args.agent as string) ?? "copilot";

    const config: AcpSessionConfig = {
      cwd,
      prompt,
      agent,
      customCommand: args.customCommand as string[] | undefined,
      model: args.model as string | undefined,
      allowedTools: args.allowedTools as string[] | undefined,
      disallowedTools: args.disallowedTools as string[] | undefined,
      worktree: args.worktree as string | undefined,
      repoRoot: args.repoRoot as string | undefined,
    };

    const sid = sessionId;
    const session = new AcpSession(sid, config, (event) => forwardSessionEvent(sid, event));
    sessions.set(sessionId, session);

    // Post initial DB upsert
    self.postMessage({
      type: "db:upsert",
      session: {
        sessionId,
        state: "connecting",
        cwd,
        worktree: config.worktree,
      },
    });

    self.postMessage({
      type: "metrics:inc",
      name: "acp_process_spawn_total",
      labels: { outcome: "attempt" },
    });

    try {
      await session.start();

      const info = session.getInfo();
      if (info.processAlive) {
        self.postMessage({
          type: "metrics:inc",
          name: "acp_process_spawn_total",
          labels: { outcome: "success" },
        });
      }
    } catch (err) {
      sessions.delete(sessionId);
      self.postMessage({ type: "db:end", sessionId });
      self.postMessage({
        type: "metrics:inc",
        name: "acp_process_spawn_total",
        labels: { outcome: "failure" },
      });
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Failed to start ACP session: ${message}` }], isError: true };
    }
  }

  const shouldWait = (args.wait as boolean) ?? false;

  if (!shouldWait) {
    return {
      content: [{ type: "text", text: JSON.stringify({ sessionId }) }],
    };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return { content: [{ type: "text", text: `Session ${sessionId} already ended` }], isError: true };
  }

  const startTime = Date.now();
  const event = await session.waitForEvent(timeoutMs);
  const durationS = (Date.now() - startTime) / 1000;
  self.postMessage({
    type: "metrics:observe",
    name: "acp_turn_duration_seconds",
    value: durationS,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    isError: event.type === "session:error",
  };
}

function handleSessionList(): { content: Array<{ type: "text"; text: string }> } {
  const list = [...sessions.values()].map((s) => s.getInfo());
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
  const timeoutMs = (args.timeout as number) ?? 300_000;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Unknown session: ${sessionId}` }], isError: true };
    }
    const event = await session.waitForEvent(timeoutMs);
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  }

  // Wait for any session
  if (sessions.size === 0) {
    return { content: [{ type: "text", text: JSON.stringify([]) }] };
  }

  const waiters = [...sessions.values()].map((s) => s.waitForEvent(timeoutMs));
  const event = await Promise.race(waiters);
  for (const p of waiters) {
    p.catch(() => {});
  }
  return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
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
    name: "acp_approval_total",
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
    name: "acp_approval_total",
    labels: { type: "manual", decision: "denied" },
  });
  return { content: [{ type: "text", text: JSON.stringify({ denied: true }) }] };
}

// ── Server startup ──

async function startServer(): Promise<void> {
  mcpServer = new Server({ name: ACP_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ACP_TOOLS.map((t) => ({
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
