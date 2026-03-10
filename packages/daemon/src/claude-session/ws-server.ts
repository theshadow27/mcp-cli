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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingPermissionInfo, SessionInfo, SessionStateEnum } from "@mcp-cli/core";
import type { ServerWebSocket } from "bun";
import type { NdjsonMessage } from "./ndjson";
import { keepAlive, parseFrame, permissionAllow, permissionDeny, setModelRequest, userMessage } from "./ndjson";
import type { CanUseToolRequest, PermissionRule, PermissionStrategy } from "./permission-router";
import { PermissionRouter } from "./permission-router";
import type { SessionEvent } from "./session-state";
import { SessionState } from "./session-state";

// ── Errors ──

/** Thrown when waitForEvent() or waitForResult() times out. */
export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitTimeoutError";
  }
}

// ── Types ──

export interface SessionConfig {
  prompt: string;
  permissionStrategy?: PermissionStrategy;
  permissionRules?: PermissionRule[];
  allowedTools?: string[];
  worktree?: string;
  cwd?: string;
  model?: string;
}

export interface TranscriptEntry {
  timestamp: number;
  direction: "inbound" | "outbound";
  message: NdjsonMessage;
}

export interface SessionDetail extends SessionInfo {
  pendingPermissionIds: string[];
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
  seq?: number;
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

/** Result from cursor-based waitForEventsSince(). */
export interface WaitResult {
  seq: number;
  events: SessionWaitEvent[];
}

interface BufferedEvent {
  event: SessionWaitEvent & { seq: number };
  ts: number;
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
  spawnAlive: boolean;
  worktree: string | null;
  resultWaiters: ResultWaiter[];
  keepAliveTimer: Timer | null;
  clearing: boolean;
  /** Claude Code's own session ID (from system/init), used for JSONL file lookup. */
  claudeSessionId: string | null;
}

interface WsData {
  sessionId: string;
}

const MAX_TRANSCRIPT = 100;
const KEEP_ALIVE_MS = 30_000;
const WS_OPEN = 1;
const MAX_EVENT_BUFFER = 1000;
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Summarize tool input to a short display string (max 80 chars). */
export function summarizeInput(input: Record<string, unknown>): string {
  const first = Object.entries(input)[0];
  if (!first) return "";
  const [key, value] = first;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  const display = `${key}=${str}`;
  return display.length > 80 ? `${display.slice(0, 77)}...` : display;
}

// ── Server ──

export class ClaudeWsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly sessions = new Map<string, WsSession>();
  private readonly eventWaiters: EventWaiter[] = [];
  private readonly spawn: SpawnFn;
  private eventSeq = 0;
  private readonly eventBuffer: BufferedEvent[] = [];
  private nextRequestId = 1;

  /** Called when session events occur (for DB updates). */
  onSessionEvent: ((sessionId: string, event: SessionEvent) => void) | null = null;

  constructor(deps?: { spawn?: SpawnFn }) {
    this.spawn = deps?.spawn ?? defaultSpawn;
  }

  /** Current event sequence number (monotonically increasing). */
  get currentSeq(): number {
    return this.eventSeq;
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
      spawnAlive: false,
      worktree: config.worktree ?? null,
      resultWaiters: [],
      keepAliveTimer: null,
      clearing: false,
      claudeSessionId: null,
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

    if (session.config.model) {
      cmd.push("--model", session.config.model);
    }
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
    session.spawnAlive = true;

    // Watch for process exit — mark spawn as dead but don't terminate the session
    proc.exited.then(() => {
      // If a new process has been spawned (e.g. via clearSession), ignore the old one
      if (session.proc !== proc) return;
      session.spawnAlive = false;
      if (session.state.state === "ended") return;
      console.error(`[_claude] Spawn exited for session ${sessionId} (pid ${proc.pid})`);
      // Move to disconnected state regardless of WS — spawn is gone
      const events = session.state.disconnect("spawn exited");
      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
      }
    });

    return proc.pid;
  }

  /** Send a follow-up prompt to an active session. Intercepts /clear and /model. */
  sendPrompt(sessionId: string, message: string): void {
    const trimmed = message.trim();

    // Intercept /clear — kill process and respawn for fresh context
    if (trimmed === "/clear") {
      this.clearSession(sessionId);
      return;
    }

    // Intercept /model — send set_model control request instead of user message
    const modelMatch = trimmed.match(/^\/model\s+(.+)$/);
    if (modelMatch) {
      this.setModel(sessionId, modelMatch[1].trim());
      return;
    }

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

  /**
   * Clear a session by killing the claude process and respawning.
   * Gives a truly fresh context without losing the session entry.
   */
  clearSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    session.clearing = true;

    // Reset state machine (preserves cumulative cost/tokens)
    const events = session.state.resetForClear();
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
      this.handleSessionEvent(sessionId, session, event);
    }

    // Clear keep-alive timer
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // Close WebSocket
    if (session.ws?.readyState === WS_OPEN) {
      session.ws.close(1000, "Session cleared");
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
      session.spawnAlive = false;
    }

    // Update config prompt to empty — next sendPrompt() will carry real work
    session.config.prompt = "";

    // Clear transcript for fresh start
    session.transcript.length = 0;

    // Respawn
    this.spawnClaude(sessionId);
    session.clearing = false;
  }

  /** Send a set_model control request to change the session's model. */
  setModel(sessionId: string, model: string): void {
    const session = this.getSession(sessionId);
    const requestId = `mcpd-model-${this.nextRequestId++}`;
    const outbound = setModelRequest(requestId, model);
    this.sendToWs(session, outbound);

    // Update tracked model in state
    const events = session.state.setModel(model);
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
      this.handleSessionEvent(sessionId, session, event);
    }
  }

  /** Gracefully end a session: close WS, stop process, clean up. Returns worktree info. */
  bye(sessionId: string): { worktree: string | null; cwd: string | null } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id ${sessionId}`);
    const info = { worktree: session.worktree, cwd: session.config.cwd ?? null };
    this.terminateSession(sessionId, session, "Session ended by user");
    return info;
  }

  /** List all sessions. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => this.buildSessionInfo(sessionId, s));
  }

  /** Get transcript for a session. Falls back to JSONL file when requesting more entries than the ring buffer holds. */
  getTranscript(sessionId: string, last?: number): TranscriptEntry[] {
    const session = this.getSession(sessionId);
    const bufferHasEnough = last === undefined || last <= session.transcript.length;

    if (bufferHasEnough) {
      if (last !== undefined && last > 0) {
        return session.transcript.slice(-last);
      }
      return [...session.transcript];
    }

    // Fall back to JSONL file on disk
    const entries = readJsonlTranscript(session.state.cwd, session.claudeSessionId, last);
    if (entries) return entries;

    // JSONL unavailable — return whatever the buffer has
    return [...session.transcript];
  }

  /** Get detailed status for a session. */
  getStatus(sessionId: string): SessionDetail {
    const session = this.getSession(sessionId);
    return {
      ...this.buildSessionInfo(sessionId, session),
      pendingPermissionIds: [...session.state.pendingPermissions.keys()],
      pid: session.pid,
    };
  }

  /** Wait for a session to produce a result. */
  waitForResult(sessionId: string, timeoutMs: number): Promise<SessionResult> {
    const session = this.getSession(sessionId);

    if (session.state.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }
    if (session.state.state === "disconnected") {
      return Promise.reject(new Error("Session is disconnected"));
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
   *
   * If a matching session is already idle or has pending permissions, resolves immediately
   * with a synthetic event instead of blocking until timeout.
   */
  waitForEvent(sessionId: string | null, timeoutMs: number): Promise<SessionWaitEvent> {
    const err = this.validateWaitTarget(sessionId);
    if (err) return Promise.reject(err);

    // Check if any matching session already has an actionable state
    const immediate = this.findImmediateEvent(sessionId);
    if (immediate) return Promise.resolve(immediate);

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
          reject(new WaitTimeoutError(`Timeout waiting for session event after ${timeoutMs}ms`));
        }, timeoutMs),
      };

      this.eventWaiters.push(waiter);
    });
  }

  /**
   * Cursor-based event wait: return buffered events after `afterSeq`, or block until one arrives.
   * On timeout, returns `{ seq: currentSeq, events: [] }` instead of throwing.
   */
  waitForEventsSince(sessionId: string | null, afterSeq: number, timeoutMs: number): Promise<WaitResult> {
    const err = this.validateWaitTarget(sessionId);
    if (err) return Promise.reject(err);

    // Check buffer for events after afterSeq
    const buffered = this.getBufferedEventsAfter(sessionId, afterSeq);
    if (buffered.length > 0) {
      return Promise.resolve({ seq: this.eventSeq, events: buffered });
    }

    // Block until next matching event
    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId,
        resolve: (e) => {
          clearTimeout(waiter.timer);
          resolve({ seq: this.eventSeq, events: [e] });
        },
        reject: (e) => {
          clearTimeout(waiter.timer);
          reject(e);
        },
        timer: setTimeout(() => {
          const idx = this.eventWaiters.indexOf(waiter);
          if (idx >= 0) this.eventWaiters.splice(idx, 1);
          // On timeout with cursor, return empty events (not an error)
          resolve({ seq: this.eventSeq, events: [] });
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

    // If reconnecting from disconnected state, transition back to connecting
    if (session.state.state === "disconnected") {
      console.error(`[_claude] WebSocket reconnected for session ${sessionId}`);
      session.state.reconnect();
    }

    // CRITICAL: Send the initial user message immediately.
    // The CLI will NOT send system/init until it receives a user message.
    const prompt = session.config.prompt;
    const outbound = userMessage(prompt, sessionId);
    try {
      ws.send(outbound);
    } catch (err) {
      console.error(`[_claude] WebSocket send failed on open for session ${sessionId}: ${err}`);
      session.ws = null;
      return;
    }
    this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: prompt } });

    // Start keep-alive
    session.keepAliveTimer = setInterval(() => {
      if (session.ws?.readyState === WS_OPEN) {
        try {
          session.ws.send(keepAlive());
        } catch (err) {
          console.error(`[_claude] WebSocket keep-alive send failed for session ${sessionId}: ${err}`);
          session.ws = null;
        }
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

    // Clear keep-alive timer (no WS to ping)
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // If already ended (bye was called) or being cleared (kill+respawn), nothing more to do
    if (session.state.state === "ended" || session.clearing) return;

    console.error(
      `[_claude] WebSocket disconnected for session ${sessionId} (spawn ${session.spawnAlive ? "alive" : "dead"})`,
    );

    // Move to disconnected state — session is NOT terminated
    const events = session.state.disconnect("WebSocket closed");
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
    }

    // Reject pending result waiters — they can't get results without WS
    for (const waiter of session.resultWaiters) {
      waiter.reject(new Error("WebSocket disconnected"));
    }
    session.resultWaiters.length = 0;
  }

  // ── Event handling ──

  private handleSessionEvent(sessionId: string, session: WsSession, event: SessionEvent): void {
    switch (event.type) {
      case "session:init":
        // Capture Claude Code's own session ID for JSONL file lookup
        session.claudeSessionId = event.sessionId;
        break;
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
      case "session:cleared":
        this.resolveEventWaiters(sessionId, {
          sessionId,
          event: "session:cleared",
        });
        break;
      case "session:model_changed":
        this.resolveEventWaiters(sessionId, {
          sessionId,
          event: "session:model_changed",
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

  /**
   * Check if any matching session is already in a state that should resolve immediately.
   * Returns a synthetic event for idle sessions (result already available) or sessions
   * with pending permissions. Returns null if no immediate event is available.
   */
  private findImmediateEvent(sessionId: string | null): SessionWaitEvent | null {
    for (const [sid, session] of this.sessions) {
      if (sessionId !== null && sid !== sessionId) continue;

      if (session.state.state === "idle") {
        return {
          sessionId: sid,
          event: "session:result",
          cost: session.state.cost,
          tokens: session.state.tokens,
          numTurns: session.state.numTurns,
        };
      }

      if (session.state.state === "waiting_permission" && session.state.pendingPermissions.size > 0) {
        const entry = session.state.pendingPermissions.entries().next().value;
        if (!entry) continue;
        const [requestId, req] = entry;
        return {
          sessionId: sid,
          event: "session:permission_request",
          requestId,
          toolName: req.tool_name,
        };
      }
    }
    return null;
  }

  /** Validate that a wait target (sessionId or any-session) is valid. Returns null if OK, Error otherwise. */
  private validateWaitTarget(sessionId: string | null): Error | null {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Error(`Unknown session: ${sessionId}`);
      if (session.state.state === "ended") return new Error("Session already ended");
      if (session.state.state === "disconnected") return new Error("Session is disconnected");
    }
    if (!sessionId && this.sessions.size === 0) {
      return new Error("No active sessions");
    }
    return null;
  }

  /** Buffer an event with a monotonic sequence number. Returns the assigned seq. */
  private bufferEvent(event: SessionWaitEvent): number {
    const seq = ++this.eventSeq;
    const tagged = { ...event, seq } as SessionWaitEvent & { seq: number };
    this.eventBuffer.push({ event: tagged, ts: Date.now() });
    this.trimEventBuffer();
    return seq;
  }

  private trimEventBuffer(): void {
    const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
    let dropCount = Math.max(0, this.eventBuffer.length - MAX_EVENT_BUFFER);
    while (dropCount < this.eventBuffer.length && this.eventBuffer[dropCount].ts < cutoff) {
      dropCount++;
    }
    if (dropCount > 0) this.eventBuffer.splice(0, dropCount);
  }

  private getBufferedEventsAfter(sessionId: string | null, afterSeq: number): SessionWaitEvent[] {
    const events: SessionWaitEvent[] = [];
    for (const entry of this.eventBuffer) {
      if (entry.event.seq <= afterSeq) continue;
      if (sessionId !== null && entry.event.sessionId !== sessionId) continue;
      events.push(entry.event);
    }
    return events;
  }

  private getSession(sessionId: string): WsSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private buildSessionInfo(sessionId: string, s: WsSession): SessionInfo {
    const details: PendingPermissionInfo[] = [];
    for (const [reqId, req] of s.state.pendingPermissions) {
      details.push({
        requestId: reqId,
        toolName: req.tool_name,
        inputSummary: summarizeInput(req.input),
      });
    }
    return {
      sessionId,
      state: s.state.state,
      model: s.state.model,
      cwd: s.state.cwd,
      cost: s.state.cost,
      tokens: s.state.tokens,
      numTurns: s.state.numTurns,
      pendingPermissions: s.state.pendingPermissions.size,
      pendingPermissionDetails: details,
      worktree: s.config.worktree ?? null,
      wsConnected: s.ws !== null,
      spawnAlive: s.spawnAlive,
    };
  }

  private sendToWs(session: WsSession, message: string): void {
    if (session.ws?.readyState === WS_OPEN) {
      try {
        session.ws.send(message);
      } catch (err) {
        console.error(`[_claude] WebSocket send failed: ${err}`);
        session.ws = null;
      }
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
    // Buffer the event with a sequence number (before resolving waiters)
    this.bufferEvent(event);

    const remaining: EventWaiter[] = [];
    for (const waiter of this.eventWaiters) {
      if (waiter.sessionId === null || waiter.sessionId === sessionId) {
        // Resolve with the buffered (seq-tagged) version
        const latest = this.eventBuffer[this.eventBuffer.length - 1];
        waiter.resolve(latest.event);
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
      session.spawnAlive = false;
    }

    // Remove from map
    this.sessions.delete(sessionId);
  }
}

// ── JSONL fallback ──

/** Message types in Claude Code's JSONL files that map to transcript entries. */
const JSONL_TRANSCRIPT_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "result", "control_request"]);

/**
 * Resolve the path to Claude Code's JSONL conversation file.
 * Path convention: ~/.claude/projects/<dash-encoded-cwd>/<claudeSessionId>.jsonl
 */
export function resolveJsonlPath(cwd: string, claudeSessionId: string): string {
  const encoded = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", encoded, `${claudeSessionId}.jsonl`);
}

/**
 * Read transcript entries from a Claude Code JSONL file on disk.
 * Returns the last `last` entries, or null if the file cannot be read.
 */
export function readJsonlTranscript(
  cwd: string | null,
  claudeSessionId: string | null,
  last: number,
): TranscriptEntry[] | null {
  if (!cwd || !claudeSessionId) return null;

  const filePath = resolveJsonlPath(cwd, claudeSessionId);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    const entries: TranscriptEntry[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!obj.type || !JSONL_TRANSCRIPT_TYPES.has(obj.type as string)) continue;

        const direction: "inbound" | "outbound" = obj.type === "user" ? "outbound" : "inbound";
        const timestamp = typeof obj.timestamp === "string" ? new Date(obj.timestamp).getTime() : Date.now();

        entries.push({
          timestamp,
          direction,
          message: obj as NdjsonMessage,
        });
      } catch {
        // Skip malformed lines
      }
    }

    return entries.slice(-last);
  } catch {
    return null;
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
