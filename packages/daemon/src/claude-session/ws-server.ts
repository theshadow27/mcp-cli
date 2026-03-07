/**
 * WebSocket server for Claude Code SDK sessions.
 *
 * Single Bun.serve() on a dynamic port, path-based routing `/session/:sessionId`.
 * Bridges NDJSON messages to SessionState machines and PermissionRouters.
 *
 * Critical: On WebSocket open, the server MUST send the initial `user` message
 * immediately. The CLI will NOT send `system/init` until it receives a user message.
 * Waiting for `system/init` first causes deadlock.
 */

import type { ServerWebSocket } from "bun";
import type { NdjsonMessage } from "./ndjson";
import { parseFrame, permissionAllow, permissionDeny, serialize, userMessage } from "./ndjson";
import type { CanUseToolRequest, PermissionRule, PermissionStrategy } from "./permission-router";
import { PermissionRouter } from "./permission-router";
import type { SessionEvent, SessionStateEnum } from "./session-state";
import { SessionState } from "./session-state";

// ── Types ──

export interface SessionConfig {
  prompt: string;
  permissionStrategy?: PermissionStrategy;
  permissionRules?: PermissionRule[];
  allowedTools?: string[];
  worktree?: string;
  cwd?: string;
}

export interface TranscriptEntry {
  timestamp: number;
  direction: "inbound" | "outbound";
  message: NdjsonMessage;
}

export interface SessionInfo {
  sessionId: string;
  state: SessionStateEnum;
  model: string | null;
  cwd: string | null;
  cost: number;
  tokens: number;
  numTurns: number;
  pendingPermissions: number;
}

export interface SessionDetail extends SessionInfo {
  pendingPermissionIds: string[];
  worktree: string | null;
  pid: number | null;
}

export interface SessionResult {
  sessionId: string;
  success: boolean;
  result?: string;
  errors?: string[];
  cost: number;
  tokens: number;
  numTurns: number;
}

/** Dependency-injectable process spawner for testing. */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd?: string; stdout?: "ignore" | "pipe"; stderr?: "ignore" | "pipe"; stdin?: "ignore" | "pipe" },
) => { pid: number; exited: Promise<number>; kill: (signal?: number) => void };

interface WsSession {
  state: SessionState;
  router: PermissionRouter;
  ws: ServerWebSocket<WsData> | null;
  transcript: TranscriptEntry[];
  config: SessionConfig;
  pid: number | null;
  proc: { kill: (signal?: number) => void; exited: Promise<number> } | null;
  worktree: string | null;
  resultWaiters: Array<{ resolve: (r: SessionResult) => void; reject: (e: Error) => void }>;
  keepAliveTimer: Timer | null;
}

interface WsData {
  sessionId: string;
}

const MAX_TRANSCRIPT = 100;
const KEEP_ALIVE_MS = 30_000;

// ── Server ──

export class ClaudeWsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly sessions = new Map<string, WsSession>();
  private readonly spawn: SpawnFn;

  /** Called when session events occur (for DB updates). */
  onSessionEvent: ((sessionId: string, event: SessionEvent) => void) | null = null;

  constructor(deps?: { spawn?: SpawnFn }) {
    this.spawn = deps?.spawn ?? defaultSpawn;
  }

  /** Start the WebSocket server. Returns the assigned port. */
  start(): number {
    this.server = Bun.serve<WsData>({
      port: 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/session\/([^/]+)$/);
        if (!match) {
          return new Response("Not found", { status: 404 });
        }
        const sessionId = match[1];
        if (!this.sessions.has(sessionId)) {
          return new Response("Unknown session", { status: 404 });
        }
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
        return undefined;
      },
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, message) => this.handleMessage(ws, String(message)),
        close: (ws) => this.handleClose(ws),
      },
    });

    return this.server.port as number;
  }

  /** Stop the server and all sessions. */
  stop(): void {
    for (const [sessionId, session] of this.sessions) {
      this.cleanupSession(sessionId, session);
    }
    this.sessions.clear();
    this.server?.stop();
    this.server = null;
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Prepare a session for an incoming Claude CLI connection.
   * Call this before spawning the Claude process.
   */
  prepareSession(sessionId: string, config: SessionConfig): void {
    const state = new SessionState(sessionId);
    const router = new PermissionRouter(config.permissionStrategy ?? "auto", config.permissionRules);

    this.sessions.set(sessionId, {
      state,
      router,
      ws: null,
      transcript: [],
      config,
      pid: null,
      proc: null,
      worktree: config.worktree ?? null,
      resultWaiters: [],
      keepAliveTimer: null,
    });
  }

  /**
   * Spawn the Claude CLI process for a prepared session.
   * Returns the PID of the spawned process.
   */
  spawnClaude(sessionId: string): number {
    const session = this.getSession(sessionId);
    const port = this.port;
    if (!port) throw new Error("WS server not started");

    const cmd = [
      "claude",
      "--sdk-url",
      `ws://localhost:${port}/session/${sessionId}`,
      "--permission-mode",
      "default",
      "-p",
      "",
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
    ];

    if (session.config.allowedTools?.length) {
      cmd.push("--allowedTools", ...session.config.allowedTools);
    }
    if (session.config.worktree) {
      cmd.push("--worktree", session.config.worktree);
    }

    const proc = this.spawn(cmd, {
      cwd: session.config.cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });

    session.pid = proc.pid;
    session.proc = proc;

    // Watch for process exit
    proc.exited.then(() => {
      const events = session.state.end();
      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
      }
      this.cleanupSession(sessionId, session);
      // Resolve any waiters with an error if still pending
      for (const waiter of session.resultWaiters) {
        waiter.reject(new Error("Claude process exited before producing a result"));
      }
      session.resultWaiters.length = 0;
    });

    return proc.pid;
  }

  /** Send a follow-up prompt to an active session. */
  sendPrompt(sessionId: string, message: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.queuePrompt(message);
    this.sendToWs(session, outbound);
    this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: message } });
  }

  /** Respond to a pending permission request. */
  respondToPermission(sessionId: string, requestId: string, allow: boolean, message?: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.respondToPermission(requestId, allow, message);
    this.sendToWs(session, outbound);
  }

  /** Interrupt the current turn. */
  interrupt(sessionId: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.interrupt();
    this.sendToWs(session, outbound);
  }

  /** List all sessions. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      state: s.state.state,
      model: s.state.model,
      cwd: s.state.cwd,
      cost: s.state.cost,
      tokens: s.state.tokens,
      numTurns: s.state.numTurns,
      pendingPermissions: s.state.pendingPermissions.size,
    }));
  }

  /** Get transcript for a session. */
  getTranscript(sessionId: string, last?: number): TranscriptEntry[] {
    const session = this.getSession(sessionId);
    if (last !== undefined && last > 0) {
      return session.transcript.slice(-last);
    }
    return [...session.transcript];
  }

  /** Get detailed status for a session. */
  getStatus(sessionId: string): SessionDetail {
    const session = this.getSession(sessionId);
    return {
      sessionId,
      state: session.state.state,
      model: session.state.model,
      cwd: session.state.cwd,
      cost: session.state.cost,
      tokens: session.state.tokens,
      numTurns: session.state.numTurns,
      pendingPermissions: session.state.pendingPermissions.size,
      pendingPermissionIds: [...session.state.pendingPermissions.keys()],
      worktree: session.worktree,
      pid: session.pid,
    };
  }

  /** Wait for a session to produce a result. */
  waitForResult(sessionId: string, timeoutMs: number): Promise<SessionResult> {
    const session = this.getSession(sessionId);

    // If already in result/idle/ended state, check immediately
    if (session.state.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }

    return new Promise<SessionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = session.resultWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) session.resultWaiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for session ${sessionId} result after ${timeoutMs}ms`));
      }, timeoutMs);

      session.resultWaiters.push({
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  // ── WebSocket handlers ──

  private handleOpen(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.close(1008, "Unknown session");
      return;
    }

    session.ws = ws;

    // CRITICAL: Send the initial user message immediately.
    // The CLI will NOT send system/init until it receives a user message.
    const prompt = session.config.prompt;
    const outbound = userMessage(prompt, sessionId);
    ws.send(outbound);
    this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: prompt } });

    // Start keep-alive
    session.keepAliveTimer = setInterval(() => {
      if (session.ws?.readyState === 1) {
        session.ws.send(serialize({ type: "keep_alive" }));
      }
    }, KEEP_ALIVE_MS);
  }

  private handleMessage(ws: ServerWebSocket<WsData>, rawMessage: string): void {
    const { sessionId } = ws.data;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let messages: NdjsonMessage[];
    try {
      messages = parseFrame(rawMessage);
    } catch {
      console.error(`[_claude] Failed to parse NDJSON from session ${sessionId}`);
      return;
    }

    for (const msg of messages) {
      this.addTranscript(session, "inbound", msg);
      const events = session.state.handleMessage(msg);

      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
        this.handleSessionEvent(sessionId, session, event);
      }
    }
  }

  private handleClose(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ws = null;
    const events = session.state.end();
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
    }

    // Resolve waiters with error
    for (const waiter of session.resultWaiters) {
      waiter.reject(new Error("WebSocket closed before result"));
    }
    session.resultWaiters.length = 0;
  }

  // ── Event handling ──

  private handleSessionEvent(sessionId: string, session: WsSession, event: SessionEvent): void {
    switch (event.type) {
      case "session:permission_request":
        this.handlePermissionRequest(sessionId, session, event.requestId, event.request);
        break;
      case "session:result":
        this.resolveWaiters(session, {
          sessionId,
          success: true,
          result: event.result,
          cost: event.cost,
          tokens: event.tokens,
          numTurns: event.numTurns,
        });
        break;
      case "session:error":
        this.resolveWaiters(session, {
          sessionId,
          success: false,
          errors: (event as SessionEvent & { type: "session:error" }).errors,
          cost: event.cost,
          tokens: 0,
          numTurns: 0,
        });
        break;
    }
  }

  private async handlePermissionRequest(
    sessionId: string,
    session: WsSession,
    requestId: string,
    request: CanUseToolRequest,
  ): Promise<void> {
    if (session.router.strategy === "delegate") {
      // Leave for external handling — the event was already emitted
      return;
    }

    const decision = await session.router.evaluate(request);
    const outbound = decision.allow
      ? permissionAllow(requestId, decision.updatedInput ?? request.input)
      : permissionDeny(requestId, decision.message ?? "Denied");

    // Update state machine
    session.state.respondToPermission(requestId, decision.allow, decision.message);
    this.sendToWs(session, outbound);
  }

  // ── Helpers ──

  private getSession(sessionId: string): WsSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private sendToWs(session: WsSession, message: string): void {
    if (session.ws?.readyState === 1) {
      session.ws.send(message);
    }
  }

  private addTranscript(session: WsSession, direction: "inbound" | "outbound", message: NdjsonMessage): void {
    session.transcript.push({ timestamp: Date.now(), direction, message });
    if (session.transcript.length > MAX_TRANSCRIPT) {
      session.transcript.shift();
    }
  }

  private resolveWaiters(session: WsSession, result: SessionResult): void {
    for (const waiter of session.resultWaiters) {
      waiter.resolve(result);
    }
    session.resultWaiters.length = 0;
  }

  private cleanupSession(sessionId: string, session: WsSession): void {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }
    if (session.ws?.readyState === 1) {
      session.ws.close(1000, "Session ended");
    }
    session.ws = null;
    if (session.proc) {
      try {
        session.proc.kill();
      } catch {
        // already dead
      }
      session.proc = null;
    }
  }
}

// ── Default spawn ──

function defaultSpawn(
  cmd: string[],
  opts: { cwd?: string; stdout?: "ignore" | "pipe"; stderr?: "ignore" | "pipe"; stdin?: "ignore" | "pipe" },
): { pid: number; exited: Promise<number>; kill: (signal?: number) => void } {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: opts.stdout === "ignore" ? null : "pipe",
    stderr: opts.stderr === "ignore" ? null : "pipe",
    stdin: opts.stdin === "ignore" ? null : "pipe",
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal?: number) => proc.kill(signal),
  };
}
