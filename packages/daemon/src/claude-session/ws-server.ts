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
import { keepAlive, parseFrame, permissionAllow, permissionDeny, userMessage } from "./ndjson";
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

interface ResultWaiter {
  resolve: (r: SessionResult) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

/** Event returned by waitForEvent(). */
export interface SessionWaitEvent {
  sessionId: string;
  event: string;
  cost?: number;
  tokens?: number;
  numTurns?: number;
  result?: string;
  errors?: string[];
  requestId?: string;
  toolName?: string;
}

interface EventWaiter {
  sessionId: string | null; // null = any session
  resolve: (e: SessionWaitEvent) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

interface WsSession {
  state: SessionState;
  router: PermissionRouter;
  ws: ServerWebSocket<WsData> | null;
  transcript: TranscriptEntry[];
  config: SessionConfig;
  pid: number | null;
  proc: { kill: (signal?: number) => void; exited: Promise<number> } | null;
  worktree: string | null;
  resultWaiters: ResultWaiter[];
  keepAliveTimer: Timer | null;
}

interface WsData {
  sessionId: string;
}

const MAX_TRANSCRIPT = 100;
const KEEP_ALIVE_MS = 30_000;
const WS_OPEN = 1;

// ── Server ──

export class ClaudeWsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly sessions = new Map<string, WsSession>();
  private readonly eventWaiters: EventWaiter[] = [];
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
  async stop(): Promise<void> {
    const exitPromises: Promise<number>[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.proc) exitPromises.push(session.proc.exited);
      this.terminateSession(sessionId, session, "Server stopping");
    }
    this.sessions.clear();
    this.server?.stop();
    this.server = null;
    // Wait for spawned processes to exit
    await Promise.allSettled(exitPromises);
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  /** Number of active (not yet ended) sessions. */
  get sessionCount(): number {
    return this.sessions.size;
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
      // Guard against double-cleanup (WS close may have already cleaned up)
      if (session.state.state === "ended") return;
      this.terminateSession(sessionId, session, "Claude process exited before producing a result");
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

  /** Gracefully end a session: close WS, stop process, clean up. */
  bye(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id ${sessionId}`);
    this.terminateSession(sessionId, session, "Session ended by user");
  }

  /** List all sessions. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => this.buildSessionInfo(sessionId, s));
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
      ...this.buildSessionInfo(sessionId, session),
      pendingPermissionIds: [...session.state.pendingPermissions.keys()],
      worktree: session.worktree,
      pid: session.pid,
    };
  }

  /** Wait for a session to produce a result. */
  waitForResult(sessionId: string, timeoutMs: number): Promise<SessionResult> {
    const session = this.getSession(sessionId);

    if (session.state.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }

    return new Promise<SessionResult>((resolve, reject) => {
      const waiter: ResultWaiter = {
        resolve: (r) => {
          clearTimeout(waiter.timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(waiter.timer);
          reject(e);
        },
        timer: setTimeout(() => {
          const idx = session.resultWaiters.indexOf(waiter);
          if (idx >= 0) session.resultWaiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for session ${sessionId} result after ${timeoutMs}ms`));
        }, timeoutMs),
      };

      session.resultWaiters.push(waiter);
    });
  }

  /**
   * Wait for the next interesting session event (result, error, or permission_request).
   * If sessionId is provided, waits for that session only. Otherwise waits for any session.
   */
  waitForEvent(sessionId: string | null, timeoutMs: number): Promise<SessionWaitEvent> {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return Promise.reject(new Error(`Unknown session: ${sessionId}`));
      if (session.state.state === "ended") {
        return Promise.reject(new Error("Session already ended"));
      }
    }

    if (!sessionId && this.sessions.size === 0) {
      return Promise.reject(new Error("No active sessions"));
    }

    return new Promise<SessionWaitEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId,
        resolve: (e) => {
          clearTimeout(waiter.timer);
          resolve(e);
        },
        reject: (e) => {
          clearTimeout(waiter.timer);
          reject(e);
        },
        timer: setTimeout(() => {
          const idx = this.eventWaiters.indexOf(waiter);
          if (idx >= 0) this.eventWaiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for session event after ${timeoutMs}ms`));
        }, timeoutMs),
      };

      this.eventWaiters.push(waiter);
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
      if (session.ws?.readyState === WS_OPEN) {
        session.ws.send(keepAlive());
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
    this.terminateSession(sessionId, session, "WebSocket closed before result");
  }

  // ── Event handling ──

  private handleSessionEvent(sessionId: string, session: WsSession, event: SessionEvent): void {
    switch (event.type) {
      case "session:permission_request":
        this.resolveEventWaiters(sessionId, {
          sessionId,
          event: "session:permission_request",
          requestId: event.requestId,
          toolName: event.request.tool_name,
        });
        this.handlePermissionRequest(session, event.requestId, event.request).catch((err) => {
          console.error(`[_claude] Permission evaluation failed for session ${sessionId}: ${err}`);
        });
        break;
      case "session:result":
        this.resolveEventWaiters(sessionId, {
          sessionId,
          event: "session:result",
          cost: event.cost,
          tokens: event.tokens,
          numTurns: event.numTurns,
          result: event.result,
        });
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
        this.resolveEventWaiters(sessionId, {
          sessionId,
          event: "session:error",
          cost: event.cost,
          errors: event.errors,
        });
        this.resolveWaiters(session, {
          sessionId,
          success: false,
          errors: event.errors,
          cost: event.cost,
          tokens: 0,
          numTurns: 0,
        });
        break;
    }
  }

  private async handlePermissionRequest(
    session: WsSession,
    requestId: string,
    request: CanUseToolRequest,
  ): Promise<void> {
    if (session.router.strategy === "delegate") {
      return;
    }

    const decision = await session.router.evaluate(request);
    const outbound = decision.allow
      ? permissionAllow(requestId, decision.updatedInput ?? request.input)
      : permissionDeny(requestId, decision.message ?? "Denied");

    session.state.respondToPermission(requestId, decision.allow, decision.message);
    this.sendToWs(session, outbound);
  }

  // ── Helpers ──

  private getSession(sessionId: string): WsSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private buildSessionInfo(sessionId: string, s: WsSession): SessionInfo {
    return {
      sessionId,
      state: s.state.state,
      model: s.state.model,
      cwd: s.state.cwd,
      cost: s.state.cost,
      tokens: s.state.tokens,
      numTurns: s.state.numTurns,
      pendingPermissions: s.state.pendingPermissions.size,
    };
  }

  private sendToWs(session: WsSession, message: string): void {
    if (session.ws?.readyState === WS_OPEN) {
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

  private resolveEventWaiters(sessionId: string, event: SessionWaitEvent): void {
    const remaining: EventWaiter[] = [];
    for (const waiter of this.eventWaiters) {
      if (waiter.sessionId === null || waiter.sessionId === sessionId) {
        waiter.resolve(event);
      } else {
        remaining.push(waiter);
      }
    }
    this.eventWaiters.length = 0;
    this.eventWaiters.push(...remaining);
  }

  /**
   * Single cleanup path: end state machine, drain waiters, clear timers,
   * close WS, kill process, remove from sessions map.
   */
  private terminateSession(sessionId: string, session: WsSession, errorMessage: string): void {
    // End state machine (idempotent — returns [] if already ended)
    const events = session.state.end();
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
    }

    // Reject pending result waiters
    for (const waiter of session.resultWaiters) {
      waiter.reject(new Error(errorMessage));
    }
    session.resultWaiters.length = 0;

    // Reject event waiters targeting this session
    const remainingEventWaiters: EventWaiter[] = [];
    for (const waiter of this.eventWaiters) {
      if (waiter.sessionId === sessionId) {
        waiter.reject(new Error(errorMessage));
      } else {
        remainingEventWaiters.push(waiter);
      }
    }
    this.eventWaiters.length = 0;
    this.eventWaiters.push(...remainingEventWaiters);

    // Clear keep-alive timer
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // Close WebSocket
    if (session.ws?.readyState === WS_OPEN) {
      session.ws.close(1000, "Session ended");
    }
    session.ws = null;

    // Kill process
    if (session.proc) {
      try {
        session.proc.kill();
      } catch {
        // already dead
      }
      session.proc = null;
    }

    // Remove from map
    this.sessions.delete(sessionId);
  }
}

// ── Default spawn ──

function defaultSpawn(
  cmd: string[],
  opts: { cwd?: string; stdout?: "ignore" | "pipe"; stderr?: "ignore" | "pipe"; stdin?: "ignore" | "pipe" },
): { pid: number; exited: Promise<number>; kill: (signal?: number) => void } {
  // Strip CLAUDECODE env var so the spawned claude process doesn't think
  // it's a nested session and refuse to start.
  const env = { ...process.env };
  env.CLAUDECODE = undefined;

  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env,
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
