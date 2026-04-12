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

import {
  CLAUDE_SERVER_NAME,
  type LiveSpan,
  type SessionInfo,
  type WorkItemEvent,
  resolveModelName,
  silentLogger,
  startSpan,
} from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SAFE_TOOLS, type PermissionRule, type PermissionStrategy } from "./claude-session/permission-router";
import type { SessionEvent } from "./claude-session/session-state";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import {
  ClaudeWsServer,
  type WaitResult,
  WaitTimeoutError,
  type WorkItemWaitEvent,
  compactifyEntry,
} from "./claude-session/ws-server";
import { aggregatePlans } from "./plan-aggregator";
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
  /** Daemon's W3C traceparent — worker span becomes a child of this. */
  traceparent?: string;
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

interface WorkItemEventMessage {
  type: "work_item_event";
  event: WorkItemEvent;
}

type ControlMessage = InitMessage | ToolsChangedMessage | RestoreSessionsMessage | WorkItemEventMessage;

const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set<ControlMessage["type"]>([
  "init",
  "tools_changed",
  "restore_sessions",
  "work_item_event",
]);
const isControlMessage = createIsControlMessage<ControlMessage>(CONTROL_MESSAGE_TYPES);

// ── Worker globals ──

declare const self: Worker;

let wsServer: ClaudeWsServer | null = null;
let mcpServer: Server | null = null;
let transport: WorkerServerTransport | null = null;

// Trace context — set on init, stable for worker lifetime
let daemonId: string | undefined;
let workerSpan: LiveSpan | undefined;

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
      case "claude_plans":
        return handleClaudePlans(server);
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

    let sessionName: string;
    try {
      sessionName = server.prepareSession(sessionId, {
        prompt,
        name: args.name as string | undefined,
        cwd: args.cwd as string | undefined,
        permissionStrategy: permissionMode,
        permissionRules: rules,
        allowedTools,
        worktree: args.worktree as string | undefined,
        model: args.model ? resolveModelName(args.model as string) : undefined,
        resumeSessionId: args.resumeSessionId as string | undefined,
        repoRoot: args.repoRoot as string | undefined,
      });
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }

    // Post DB upsert
    self.postMessage({
      type: "db:upsert",
      session: {
        sessionId,
        name: sessionName,
        state: "connecting",
        cwd: args.cwd as string | undefined,
        worktree: args.worktree as string | undefined,
        repoRoot: args.repoRoot as string | undefined,
      },
    });

    const pid = server.spawnClaude(sessionId, workerSpan?.traceparent());

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

/**
 * Check if a session's cwd is within the scope root.
 * Returns true when scopeRoot is undefined (no filter).
 */
export function matchesScopeRoot(
  session: Pick<SessionInfo, "cwd"> | undefined,
  scopeRoot: string | undefined,
): boolean {
  if (!scopeRoot) return true;
  if (!session) return false;
  const cwd = session.cwd;
  return cwd !== null && cwd !== undefined && (cwd === scopeRoot || cwd.startsWith(`${scopeRoot}/`));
}

/**
 * Check if a session belongs to the given repo root.
 * Falls back to cwd prefix for sessions missing repoRoot (fixes #1242, #1308).
 * Returns true when repoRoot is undefined (no filter).
 */
export function matchesRepoRoot(
  session: Pick<SessionInfo, "cwd" | "repoRoot"> | undefined,
  repoRoot: string | undefined,
): boolean {
  if (!repoRoot) return true;
  if (!session) return false;
  if (session.repoRoot) return session.repoRoot === repoRoot;
  const cwd = session.cwd;
  return cwd !== null && cwd !== undefined && (cwd === repoRoot || cwd.startsWith(`${repoRoot}/`));
}

function handleSessionList(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  let sessions = server.listSessions();
  const repoRoot = args.repoRoot as string | undefined;
  const scopeRoot = args.scopeRoot as string | undefined;
  if (scopeRoot) {
    sessions = sessions.filter((s) => matchesScopeRoot(s, scopeRoot));
  } else if (repoRoot) {
    sessions = sessions.filter((s) => matchesRepoRoot(s, repoRoot));
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
  const message = typeof args.message === "string" ? args.message : undefined;
  const { worktree, cwd, repoRoot } = await server.bye(args.sessionId as string, message);
  return { content: [{ type: "text", text: JSON.stringify({ ended: true, worktree, cwd, repoRoot }) }] };
}

function handleTranscript(
  server: ClaudeWsServer,
  args: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const limit = (args.limit as number) ?? 50;
  const compact = (args.compact as boolean) ?? false;
  const transcript = server.getTranscript(args.sessionId as string, limit);

  if (compact) {
    const compacted = transcript.map(compactifyEntry);
    return { content: [{ type: "text", text: JSON.stringify(compacted, null, 2) }] };
  }

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

function handleClaudePlans(server: ClaudeWsServer): {
  content: Array<{ type: "text"; text: string }>;
} {
  const sessions = server.listSessions();
  // Intentionally reads only the in-memory ring buffer (last ~100 entries)
  // rather than falling back to JSONL on disk. Reading JSONL for every live
  // session on every poll cycle would trigger synchronous readFileSync and
  // stall the WebSocket keepalive loop. For plans, TodoWrite typically
  // appears in the most recent ~50 entries so the buffer is sufficient.
  const plans = aggregatePlans(sessions, (id) => server.getTranscript(id));
  return { content: [{ type: "text", text: JSON.stringify(plans) }] };
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
  const scopeRoot = args.scopeRoot as string | undefined;
  const any = args.any === true;
  const prNumber = typeof args.pr === "number" ? args.pr : null;
  const checks = args.checks === true;

  const eventInScope = (e: { session?: SessionInfo }): boolean => {
    if (!scopeRoot && !repoRoot) return true;
    // Events without session info can't be filtered — drop them when a filter is active
    // rather than leaking cross-repo wakeups (fixes #1308).
    if (!e.session) return false;
    if (scopeRoot) return matchesScopeRoot(e.session, scopeRoot);
    return matchesRepoRoot(e.session, repoRoot);
  };

  // Work-item-only paths: --pr or --checks without --any
  if ((prNumber !== null || checks) && !any) {
    return handleWorkItemWait(server, prNumber, checks, timeoutMs);
  }

  // --any: race session events against work item events
  if (any) {
    return handleAnyWait(server, sessionId, prNumber, checks, timeoutMs, afterSeq, repoRoot, scopeRoot);
  }

  const deadline = Date.now() + timeoutMs;
  const timeoutResponse = () => handleSessionList(server, { scopeRoot, repoRoot });

  // Cursor-based path: use waitForEventsSince. Re-subscribe with the advanced cursor
  // when all events in a batch are filtered out, so the wait respects the requested
  // timeout instead of returning a false wakeup (fixes #1308).
  if (afterSeq !== undefined) {
    let seq = afterSeq;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { content: [{ type: "text", text: JSON.stringify({ seq, events: [] }, null, 2) }] };
      }
      const result: WaitResult = await server.waitForEventsSince(sessionId, seq, remaining);
      seq = result.seq;
      if (result.events.length === 0) {
        // Real timeout from the subscriber — don't loop
        return { content: [{ type: "text", text: JSON.stringify({ seq, events: [] }, null, 2) }] };
      }
      const filtered = result.events.filter(eventInScope);
      if (filtered.length > 0) {
        return { content: [{ type: "text", text: JSON.stringify({ seq, events: filtered }, null, 2) }] };
      }
      // All events filtered out — loop with advanced cursor
    }
  }

  // Legacy path: unified { event?, sessions } shape. Re-subscribe for the remaining
  // timeout when a wakeup is from an out-of-scope session (fixes #1308).
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timeoutResponse();
    try {
      const event = await server.waitForEvent(sessionId, remaining);
      if (!eventInScope(event)) continue;
      const filteredSessions = JSON.parse(timeoutResponse().content[0].text) as SessionInfo[];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: "session", event, sessions: filteredSessions }, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof WaitTimeoutError) return timeoutResponse();
      throw err;
    }
  }
}

/** Handle wait for work item events only (--pr or --checks without --any). */
async function handleWorkItemWait(
  server: ClaudeWsServer,
  prNumber: number | null,
  checksOnly: boolean,
  timeoutMs: number,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await server.waitForWorkItemEvent(prNumber, checksOnly, timeoutMs);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { source: "work_item", workItemEvent: result.workItemEvent, sessions: server.listSessions() },
            null,
            2,
          ),
        },
      ],
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

/** Handle --any: race session events against work item events. */
async function handleAnyWait(
  server: ClaudeWsServer,
  sessionId: string | null,
  prNumber: number | null,
  checksOnly: boolean,
  timeoutMs: number,
  afterSeq: number | undefined,
  repoRoot: string | undefined,
  scopeRoot: string | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const eventInScope = (e: { session?: SessionInfo }): boolean => {
    if (!scopeRoot && !repoRoot) return true;
    if (!e.session) return false;
    if (scopeRoot) return matchesScopeRoot(e.session, scopeRoot);
    return matchesRepoRoot(e.session, repoRoot);
  };

  // AbortController for cancelling the losing racer after Promise.race settles.
  // Without this, the loser's internal timeout timer fires and rejects an unobserved
  // promise, causing an unhandled rejection on every successful --any call.
  const abort = new AbortController();

  const workItemPromise = server
    .waitForWorkItemEvent(prNumber, checksOnly, timeoutMs, abort.signal)
    .then((r) => ({ kind: "work_item" as const, result: r }));

  type SessionResult = { kind: "session"; result: unknown };

  let sessionPromise: Promise<SessionResult>;
  if (afterSeq !== undefined) {
    // Wrap in a re-subscribing loop: if scope/repoRoot filtering empties the result,
    // re-subscribe with the updated seq instead of returning a never-resolving promise.
    sessionPromise = (async (): Promise<SessionResult> => {
      let currentSeq = afterSeq;
      while (!abort.signal.aborted) {
        const r = await server.waitForEventsSince(sessionId, currentSeq, timeoutMs, abort.signal);
        // Advance cursor even if events are filtered — prevents re-reading the same batch
        currentSeq = r.seq;
        r.events = r.events.filter(eventInScope);
        if (r.events.length > 0) {
          return { kind: "session" as const, result: r };
        }
        // Empty events after filtering = timeout expired with no in-scope events.
        // If the wait itself timed out (returned empty without blocking), bail out
        // to let the work item side or overall timeout win.
        if (r.events.length === 0) {
          // waitForEventsSince returns empty on timeout — don't loop forever
          return new Promise<never>(() => {}); // let the other racer or timeout win
        }
      }
      // Aborted — return a never-resolving promise (race already settled)
      return new Promise<never>(() => {});
    })();
  } else {
    sessionPromise = server
      .waitForEvent(sessionId, timeoutMs, abort.signal)
      .then<SessionResult>((event) => {
        if (!eventInScope(event)) return new Promise<never>(() => {});
        return { kind: "session" as const, result: event };
      })
      .catch((err) => {
        if (err instanceof WaitTimeoutError) return new Promise<never>(() => {}); // let work item win
        throw err;
      });
  }

  // Race — whichever resolves first wins
  try {
    const winner = await Promise.race([sessionPromise, workItemPromise]);

    // Cancel the loser's timer and remove it from the waiter array
    abort.abort();

    if (winner.kind === "work_item") {
      const wiEvent = winner.result as WorkItemWaitEvent;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { source: "work_item", workItemEvent: wiEvent.workItemEvent, sessions: server.listSessions() },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Session event — always include source field for consumer disambiguation
    if (afterSeq !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { source: "session", ...(winner.result as object), sessions: server.listSessions() },
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ source: "session", event: winner.result, sessions: server.listSessions() }, null, 2),
        },
      ],
    };
  } catch (err) {
    abort.abort();
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
      // Forward the actual state from the state machine — not a hardcoded "init".
      // If the CLI reconnects after a WS drop and re-sends system/init, the
      // state machine preserves its current state (e.g., "idle") rather than
      // regressing to "init". Forwarding event.state keeps the DB in sync.
      self.postMessage({
        type: "db:upsert",
        session: {
          sessionId,
          state: event.state,
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
    case "session:rate_limited":
      self.postMessage({ type: "metrics:inc", name: "mcpd_session_rate_limited_total" });
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
      } else if (data.type === "work_item_event" && wsServer) {
        wsServer.dispatchWorkItemEvent(data.event);
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
    workerSpan = startSpan("claude-worker", {
      parentTraceparent: data.traceparent,
    });
    try {
      const port = await startServer(data.wsPort, data.quiet);
      self.postMessage({ type: "ready", port });
    } catch (err) {
      // Clean up partially-initialized resources
      await wsServer?.stop().catch(() => {});
      wsServer = null;
      mcpServer = null;
      transport = null;
      workerSpan?.end();
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", message });
    }
  }
};

// End the worker span when the worker is terminated
self.addEventListener("close", () => {
  workerSpan?.end();
});
