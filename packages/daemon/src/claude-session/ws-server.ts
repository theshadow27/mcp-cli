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
import type {
  AgentPermissionRequest,
  Logger,
  MonitorEventInput,
  SessionInfo,
  SessionStateEnum,
  WorkItemEvent,
} from "@mcp-cli/core";
import {
  CHECKS_FAILED,
  CHECKS_PASSED,
  CHECKS_STARTED,
  PHASE_CHANGED,
  PR_CLOSED,
  PR_MERGED,
  PR_MERGE_STATE_CHANGED,
  PR_OPENED,
  PR_PUSHED,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  SESSION_CLEARED,
  SESSION_CONTAINMENT_DENIED,
  SESSION_CONTAINMENT_ESCALATED,
  SESSION_CONTAINMENT_RESET,
  SESSION_CONTAINMENT_WARNING,
  SESSION_DISCONNECTED,
  SESSION_ENDED,
  SESSION_ERROR,
  SESSION_IDLE,
  SESSION_MODEL_CHANGED,
  SESSION_PERMISSION_REQUEST,
  SESSION_RATE_LIMITED,
  SESSION_RESULT,
  SESSION_STUCK,
  consoleLogger,
  generateSessionName,
} from "@mcp-cli/core";
import type { ServerWebSocket } from "bun";
import { killPid } from "../process-util";
import { ContainmentGuard } from "./containment";
import type { NdjsonMessage } from "./ndjson";
import { keepAlive, parseFrame, permissionAllow, permissionDeny, setModelRequest, userMessage } from "./ndjson";
import type { CanUseToolRequest, PermissionRule, PermissionStrategy } from "./permission-router";
import { PermissionRouter } from "./permission-router";
import type { SessionEvent } from "./session-state";
import { IGNORED_TYPES, SessionState } from "./session-state";
import { DEFAULT_STUCK_CONFIG, StuckDetector, type StuckDetectorConfig, type StuckEvent } from "./stuck-detector";

// ── Constants ──

/** Time (ms) to wait after SIGTERM before escalating to SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;
/** Time (ms) to wait after SIGKILL before giving up. */
const KILL_SIGKILL_GRACE_MS = 2_000;
/** Time (ms) to wait for a WebSocket connection after spawning a Claude CLI process. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Message types handled by the state machine's dispatch. */
const HANDLED_MSG_TYPES: ReadonlyArray<string> = ["system", "assistant", "result", "control_request"];

/**
 * Message types that the daemon knows about (handled or intentionally ignored).
 * Derived from IGNORED_TYPES (session-state.ts) + handled types to stay in sync.
 */
const KNOWN_MSG_TYPES: ReadonlySet<string> = new Set([...HANDLED_MSG_TYPES, ...IGNORED_TYPES]);

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
  /** Human-readable session name. Auto-generated if not provided. */
  name?: string;
  permissionStrategy?: PermissionStrategy;
  permissionRules?: PermissionRule[];
  allowedTools?: string[];
  worktree?: string;
  cwd?: string;
  model?: string;
  /**
   * Claude CLI session ID to resume (restores conversation history via --resume).
   * Set to a specific UUID to resume that session, or "continue" to resume
   * the most recent conversation in the cwd (via --continue).
   */
  resumeSessionId?: string;
  /** Repo root captured at spawn time, used for worktree hook config lookup at teardown. */
  repoRoot?: string;
}

export interface TranscriptEntry {
  timestamp: number;
  direction: "inbound" | "outbound";
  message: NdjsonMessage;
}

/** Lightweight transcript entry for monitoring — omits verbose metadata. */
export interface CompactTranscriptEntry {
  timestamp: number;
  role: string;
  content: string | null;
  tool?: string;
}

/** Convert a full TranscriptEntry to compact form. */
export function compactifyEntry(entry: TranscriptEntry): CompactTranscriptEntry {
  const type = entry.message.type ?? "unknown";

  // Derive role from message type
  const role =
    type === "user"
      ? "user"
      : type === "assistant"
        ? "assistant"
        : type === "result"
          ? "result"
          : type === "system"
            ? "system"
            : type;

  let content: string | null = null;
  let tool: string | undefined;

  if ((type === "user" || type === "assistant") && entry.message.message) {
    const msg = entry.message.message as { content?: unknown };
    content = extractContentSummaryPlain(msg.content);
  } else if (type === "result") {
    const res = entry.message as { result?: string };
    content = res.result ?? null;
  }

  // Truncate to 200 chars
  if (content && content.length > 200) {
    content = `${content.slice(0, 200)}…`;
  }

  // Extract tool name from assistant tool_use blocks
  if (type === "assistant" && entry.message.message) {
    const msg = entry.message.message as { content?: unknown };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") {
          tool = (block as Record<string, unknown>).name as string;
          break;
        }
      }
    }
  }

  const result: CompactTranscriptEntry = { timestamp: entry.timestamp, role, content };
  if (tool) result.tool = tool;
  return result;
}

/** Extract content summary without ANSI color codes (for JSON output). */
function extractContentSummaryPlain(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push(`[tool_use: ${b.name}]`);
      } else if (b.type === "tool_result") {
        const rc = b.content;
        if (typeof rc === "string") {
          parts.push(rc);
        } else {
          parts.push("[tool_result]");
        }
      }
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
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
  opts: {
    cwd?: string;
    stdout?: "ignore" | "pipe";
    stderr?: "ignore" | "pipe";
    stdin?: "ignore" | "pipe";
    env?: Record<string, string | undefined>;
  },
) => {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: number) => void;
  stderr?: ReadableStream<Uint8Array> | null;
};

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
  strikes?: number;
  /** Stuck-event fields (present when event === "session:stuck"). */
  tier?: number;
  sinceMs?: number;
  tokenDelta?: number;
  lastTool?: string | null;
  lastToolError?: string | null;
  /** Full session snapshot at the time of the event (same fields as claude_session_list). */
  session?: SessionInfo;
}

/** Result from cursor-based waitForEventsSince(). */
export interface WaitResult {
  seq: number;
  events: SessionWaitEvent[];
}

/** Event returned when a work item event resolves a waiter. */
export interface WorkItemWaitEvent {
  source: "work_item";
  workItemEvent: WorkItemEvent;
}

interface BufferedEvent {
  event: SessionWaitEvent & { seq: number };
  ts: number;
}

interface BufferedWorkItemEvent {
  event: WorkItemWaitEvent;
  ts: number;
}

interface EventWaiter {
  sessionId: string | null; // null = any session
  resolve: (e: SessionWaitEvent) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

interface WorkItemWaiter {
  prNumber: number | null; // null = any PR
  checksOnly: boolean; // true = only checks:* events
  resolve: (e: WorkItemWaitEvent) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

interface WsSession {
  state: SessionState;
  router: PermissionRouter;
  ws: ServerWebSocket<WsData> | null;
  transcript: TranscriptEntry[];
  config: SessionConfig;
  /** Human-readable session name. */
  name: string | null;
  pid: number | null;
  /** Process start time (epoch ms) — used to detect PID reuse before sending signals. */
  pidStartTime: number | null;
  proc: { kill: (signal?: number) => void; exited: Promise<number> } | null;
  spawnAlive: boolean;
  worktree: string | null;
  containment: ContainmentGuard | null;
  resultWaiters: ResultWaiter[];
  keepAliveTimer: Timer | null;
  clearing: boolean;
  /** Claude Code's own session ID (from system/init), used for JSONL file lookup. */
  claudeSessionId: string | null;
  /** Timer that fires if the Claude CLI process doesn't connect via WS within the deadline. */
  connectTimer: Timer | null;
  /** Unix timestamp (ms) when this session was created. */
  createdAt: number;
  /** W3C traceparent used for the last spawn — reused on respawn after clear. */
  traceparent: string | null;
  /** Per-session idle watchdog — detects stalled sessions (#1585). */
  stuckDetector: StuckDetector | null;
  /**
   * Whether this session has an unreported actionable state (idle or waiting_permission).
   * Set to true when the session transitions to an actionable state via a real event.
   * Cleared after findImmediateEvent reports it. Prevents wait from returning the same
   * stale idle session on every call (fixes #985).
   */
  pendingImmediate: boolean;
  /**
   * Sticky flag: set when session:result or session:error fires, never cleared
   * by state transitions (unlike state which goes idle→disconnected on WS drop).
   * Used to decide auto-termination on process exit — survives the WS-close-then-
   * proc-exit race where transient state is already "disconnected".
   * Reset only on clearSession (respawn = fresh work cycle).
   */
  workCompleted: boolean;
}

interface WsData {
  sessionId: string;
}

const MAX_TRANSCRIPT = 100;
const KEEP_ALIVE_MS = 30_000;
const WS_OPEN = 1;
const MAX_EVENT_BUFFER = 1000;
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_WORK_ITEM_BUFFER = 100;
const WORK_ITEM_BUFFER_TTL_MS = 60 * 1000; // 1 minute — work item events are polled, not streamed

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

/** Default interval (ms) between attempts to reclaim the well-known WS port. */
const PORT_RECLAIM_INTERVAL_MS = 30_000;

export class ClaudeWsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** Second server on the well-known port, created after successful reclaim. */
  private reclaimServer: ReturnType<typeof Bun.serve> | null = null;
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, WsSession>();
  private readonly eventWaiters: EventWaiter[] = [];
  private readonly workItemWaiters: WorkItemWaiter[] = [];
  private readonly workItemBuffer: BufferedWorkItemEvent[] = [];
  private readonly spawn: SpawnFn;
  private readonly killTimeoutMs: number;
  private readonly portRetryCount: number;
  private readonly portRetryDelayMs: number;
  private readonly reclaimIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly stuckConfig: StuckDetectorConfig;
  private eventSeq = 0;
  private readonly eventBuffer: BufferedEvent[] = [];
  private nextRequestId = 1;
  private readonly logger: Logger;

  /** Called when session events occur (for DB updates). */
  onSessionEvent: ((sessionId: string, event: SessionEvent) => void) | null = null;

  /** Called to forward monitor events to the main thread's EventBus (#1567). */
  onMonitorEvent: ((input: MonitorEventInput) => void) | null = null;

  constructor(deps?: {
    spawn?: SpawnFn;
    killTimeoutMs?: number;
    logger?: Logger;
    portRetryCount?: number;
    portRetryDelayMs?: number;
    reclaimIntervalMs?: number;
    connectTimeoutMs?: number;
    stuckConfig?: StuckDetectorConfig;
  }) {
    this.spawn = deps?.spawn ?? defaultSpawn;
    this.killTimeoutMs = deps?.killTimeoutMs ?? KILL_TIMEOUT_MS;
    this.logger = deps?.logger ?? consoleLogger;
    this.portRetryCount = deps?.portRetryCount ?? 10;
    this.portRetryDelayMs = deps?.portRetryDelayMs ?? 500;
    this.reclaimIntervalMs = deps?.reclaimIntervalMs ?? PORT_RECLAIM_INTERVAL_MS;
    this.connectTimeoutMs = deps?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.stuckConfig = deps?.stuckConfig ?? DEFAULT_STUCK_CONFIG;
  }

  /** Current event sequence number (monotonically increasing). */
  get currentSeq(): number {
    return this.eventSeq;
  }

  /** Create a Bun.serve() instance with the WS routing handlers. */
  private createServer(p: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<WsData>({
      port: p,
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
  }

  /** Start the WebSocket server. Returns the assigned port.
   *  If `port` is provided and non-zero, tries that port first;
   *  retries up to MAX_PORT_RETRIES times with backoff before falling back
   *  to a random OS-assigned port on EADDRINUSE. */
  async start(port?: number): Promise<number> {
    const requestedPort = port ?? 0;

    if (requestedPort !== 0) {
      for (let attempt = 0; attempt <= this.portRetryCount; attempt++) {
        try {
          this.server = this.createServer(requestedPort);
          return this.server.port as number;
        } catch (err) {
          if (!isAddrInUse(err)) throw err;
          if (attempt < this.portRetryCount) {
            await Bun.sleep(this.portRetryDelayMs);
            continue;
          }
          // All retries exhausted — fall back to random port
          this.logger.error(
            `[ws-server] Port ${requestedPort} still in use after ${this.portRetryCount} retries, falling back to random port`,
          );
        }
      }
    }

    this.server = this.createServer(0);

    // Started on a fallback port — begin periodic reclaim attempts
    if (requestedPort !== 0) {
      this.startReclaimLoop(requestedPort);
    }

    return this.server.port as number;
  }

  /** True when the well-known port has been reclaimed (a second server is running). */
  get reclaimed(): boolean {
    return this.reclaimServer !== null;
  }

  /**
   * Start a background loop that periodically tries to bind the well-known port.
   * On success, a second Bun.serve() is created on that port — existing connections
   * on the fallback port are maintained, and new sessions use the well-known port.
   */
  private startReclaimLoop(wellKnownPort: number): void {
    this.reclaimTimer = setInterval(() => {
      try {
        const srv = this.createServer(wellKnownPort);
        this.reclaimServer = srv;
        this.stopReclaimLoop();
        this.logger.info(`[ws-server] Reclaimed well-known port ${wellKnownPort}`);
      } catch (err) {
        if (!isAddrInUse(err)) {
          this.logger.error(`[ws-server] Unexpected error reclaiming port ${wellKnownPort}: ${err}`);
          this.stopReclaimLoop();
        }
        // EADDRINUSE — port still occupied, will retry next interval
      }
    }, this.reclaimIntervalMs);
  }

  /** Stop the reclaim retry loop. */
  private stopReclaimLoop(): void {
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
  }

  /** Stop the server and all sessions. */
  async stop(): Promise<void> {
    this.stopReclaimLoop();
    const terminations: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions) {
      terminations.push(this.terminateSession(sessionId, session, "Server stopping"));
    }
    await Promise.allSettled(terminations);
    // terminateSession removes each session from the map; nothing left to clear.
    this.reclaimServer?.stop();
    this.reclaimServer = null;
    this.server?.stop();
    this.server = null;
  }

  get port(): number {
    // Prefer the reclaimed well-known port for new sessions
    return this.reclaimServer?.port ?? this.server?.port ?? 0;
  }

  /** Number of active (not yet ended) sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Restore sessions from persisted state (e.g., after daemon restart).
   * Creates session entries in `disconnected` state with no WS or process.
   * When Claude CLI reconnects to `/session/{id}`, the existing handleOpen()
   * will transition the session back to `connecting`.
   */
  restoreSessions(
    sessions: Array<{
      sessionId: string;
      name?: string | null;
      pid: number | null;
      pidStartTime?: number | null;
      state: string;
      model: string | null;
      cwd: string | null;
      worktree: string | null;
      totalCost: number;
      totalTokens: number;
      spawnedAt?: string | null;
    }>,
  ): number {
    let restored = 0;
    for (const s of sessions) {
      // Skip sessions already in the map (shouldn't happen, but be safe)
      if (this.sessions.has(s.sessionId)) continue;

      const state = new SessionState(s.sessionId);
      state.state = "disconnected";
      state.model = s.model;
      state.cwd = s.cwd;
      state.cost = s.totalCost;
      state.tokens = s.totalTokens;

      const router = new PermissionRouter("auto");

      this.sessions.set(s.sessionId, {
        state,
        router,
        ws: null,
        transcript: [],
        config: { prompt: "", worktree: s.worktree ?? undefined },
        name: s.name ?? null,
        pid: s.pid,
        pidStartTime: s.pidStartTime ?? null,
        proc: null,
        spawnAlive: false,
        worktree: s.worktree,
        containment: s.worktree && s.cwd ? new ContainmentGuard(s.cwd) : null,
        resultWaiters: [],
        keepAliveTimer: null,
        clearing: false,
        claudeSessionId: null,
        connectTimer: null,
        createdAt: s.spawnedAt ? new Date(`${s.spawnedAt}Z`).getTime() : Date.now(),
        pendingImmediate: false, // Restored sessions have no new events
        workCompleted: false,
        traceparent: null,
        stuckDetector: null,
      });
      restored++;
      this.logger.info(`[_claude] Restored session ${s.sessionId} (state: disconnected, pid: ${s.pid})`);
    }
    return restored;
  }

  /**
   * Prepare a session for an incoming Claude CLI connection.
   * Call this before spawning the Claude process.
   */
  /** Prepare a session and return the assigned name. */
  prepareSession(sessionId: string, config: SessionConfig): string {
    const state = new SessionState(sessionId);
    const router = new PermissionRouter(config.permissionStrategy ?? "auto", config.permissionRules);

    // Auto-generate a name if not explicitly provided
    // If an explicit name was given, reject duplicates among active sessions
    if (config.name) {
      const nameLower = config.name.toLowerCase();
      for (const s of this.sessions.values()) {
        if (s.name?.toLowerCase() === nameLower) {
          throw new Error(`Session name "${config.name}" is already in use`);
        }
      }
    }
    const name = config.name ?? this.generateName();

    this.sessions.set(sessionId, {
      state,
      router,
      ws: null,
      transcript: [],
      config,
      name,
      pid: null,
      pidStartTime: null,
      proc: null,
      spawnAlive: false,
      worktree: config.worktree ?? null,
      containment: config.worktree && config.cwd ? new ContainmentGuard(config.cwd) : null,
      resultWaiters: [],
      keepAliveTimer: null,
      clearing: false,
      claudeSessionId: null,
      connectTimer: null,
      createdAt: Date.now(),
      pendingImmediate: false,
      workCompleted: false,
      traceparent: null,
      stuckDetector: null,
    });
    return name;
  }

  /**
   * Spawn the Claude CLI process for a prepared session.
   * Returns the PID of the spawned process.
   * @param traceparent Optional W3C traceparent to propagate via TRACEPARENT env var.
   */
  spawnClaude(sessionId: string, traceparent?: string): number {
    const session = this.getSession(sessionId);
    // Store traceparent so respawn after clear can reuse it
    if (traceparent) session.traceparent = traceparent;
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
    if (session.config.worktree && !session.config.cwd) {
      // Only pass --worktree when cwd is not set. When both are present,
      // the worktree was pre-created by a lifecycle hook and cwd already
      // points to it — passing --worktree would make Claude try to create
      // another worktree.
      cmd.push("--worktree", session.config.worktree);
    }
    if (session.config.resumeSessionId) {
      if (session.config.resumeSessionId === "continue") {
        cmd.push("--continue");
      } else {
        cmd.push("--resume", session.config.resumeSessionId);
      }
    }

    const envOverrides: Record<string, string | undefined> = {};
    if (traceparent) envOverrides.TRACEPARENT = traceparent;
    // Pin GIT_DIR/GIT_WORK_TREE so the worker cannot escape its worktree via
    // git even if cwd drifts. Only applies when a pre-created worktree is in
    // use (both cwd and worktree name are set — see comment at --worktree flag
    // above).
    if (session.config.cwd && session.config.worktree) {
      envOverrides.GIT_DIR = `${session.config.cwd}/.git`;
      envOverrides.GIT_WORK_TREE = session.config.cwd;
    }
    const proc = this.spawn(cmd, {
      cwd: session.config.cwd,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      env: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
    });

    session.pid = proc.pid;
    session.proc = proc;
    session.spawnAlive = true;

    // Start connect timeout — if no WS connection arrives within the deadline,
    // kill the stuck process and transition to disconnected. This prevents sessions
    // from being stuck in "connecting" forever when the Claude CLI fails to establish
    // a WebSocket connection (e.g., race after daemon auto-start, #837).
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.connectTimer = setTimeout(() => {
      session.connectTimer = null;
      // Only act if still in connecting state with no WS
      if (session.ws !== null || session.state.state !== "connecting") return;
      this.logger.error(
        `[_claude] Connect timeout for session ${sessionId} — Claude CLI did not connect within ${this.connectTimeoutMs}ms`,
      );
      // Kill the stuck process
      if (session.proc) {
        try {
          session.proc.kill();
        } catch {
          /* already dead */
        }
      }
      // Transition to disconnected so callers see a clear state
      const events = session.state.disconnect("connect timeout");
      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
        try {
          this.handleSessionEvent(sessionId, session, event);
        } catch (err) {
          this.logger.error(
            `[_claude] handleSessionEvent failed for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
          );
        }
      }
    }, this.connectTimeoutMs);

    // Drain stderr immediately to prevent pipe buffer deadlock.
    // On macOS the pipe buffer is 64KB — if the child writes more than that
    // without the parent reading, the child blocks on the write syscall.
    // This is the root cause of #546: hook-created worktrees in complex repos
    // (git-crypt, large projects) produce enough stderr during Claude startup
    // to fill the buffer, blocking Claude before it connects via WebSocket.
    //
    // Per-process buffer: captured by closure so old drain coroutines can't
    // contaminate a new process's buffer after clearSession respawns.
    const procStderrLines: string[] = [];
    const drainDone = proc.stderr
      ? drainStderr(proc.stderr, procStderrLines).catch(() => {
          /* stream closed — expected on process exit */
        })
      : Promise.resolve();

    // Watch for process exit
    proc.exited.then(async () => {
      // If a new process has been spawned (e.g. via clearSession), ignore the old one
      if (session.proc !== proc) return;
      session.spawnAlive = false;
      if (session.state.state === "ended") return;
      // Wait for drain to finish — proc.exited fires when the kernel reaps
      // the process, but the pipe may still have buffered data.
      await drainDone;
      // Re-check after async drain — a clearSession or bye may have run
      if (session.proc !== proc || (session.state.state as string) === "ended") return;
      const suffix = procStderrLines.length > 0 ? `: ${procStderrLines.join("\n")}` : "";
      this.logger.error(
        `[_claude] Spawn exited for session ${sessionId} (pid ${proc.pid}, state ${session.state.state}, workCompleted ${session.workCompleted})${suffix}`,
      );

      // If the session completed its work (session:result or session:error
      // fired), auto-terminate instead of leaving a zombie disconnected
      // session. Uses the sticky workCompleted flag rather than transient
      // state — state may already be "disconnected" if WS closed first.
      if (session.workCompleted) {
        this.logger.info(`[_claude] Auto-terminating completed session ${sessionId} after process exit`);
        await this.terminateSession(sessionId, session, "Process exited after completion");
        return;
      }

      // For sessions that never completed work, transition to disconnected —
      // the orchestrator may still want to inspect them.
      const events = session.state.disconnect("spawn exited");
      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
        try {
          this.handleSessionEvent(sessionId, session, event);
        } catch (err) {
          this.logger.error(
            `[_claude] handleSessionEvent failed for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
          );
        }
      }
      // Reject pending result waiters — they can't get results without a process
      for (const waiter of session.resultWaiters) {
        waiter.reject(new Error("Process exited"));
      }
      session.resultWaiters.length = 0;
    });

    return proc.pid;
  }

  /** Send a follow-up prompt to an active session. Intercepts /clear and /model. */
  sendPrompt(sessionId: string, message: string): void {
    const trimmed = message.trim();

    // Intercept /clear — kill process and respawn for fresh context
    if (trimmed === "/clear") {
      this.clearSession(sessionId).catch((err) => {
        this.logger.error(`[_claude] clearSession failed for ${sessionId}:`, err);
        // Remove the stuck session so it doesn't remain in clearing=true permanently.
        const stuck = this.sessions.get(sessionId);
        if (stuck) {
          this.terminateSession(sessionId, stuck, "clearSession failed").catch(console.error);
        }
      });
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
    this.recordSessionProgress(sessionId, session);
  }

  /** Respond to a pending permission request. */
  respondToPermission(sessionId: string, requestId: string, allow: boolean, message?: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.respondToPermission(requestId, allow, message);
    this.sendToWs(session, outbound);
    this.recordSessionProgress(sessionId, session);
  }

  /** Interrupt the current turn. */
  interrupt(sessionId: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.interrupt();
    this.sendToWs(session, outbound);
  }

  /**
   * Kill a raw PID (no proc handle) with SIGTERM → SIGKILL escalation.
   * Delegates to the shared killPid utility.
   */
  private async killRawPid(pid: number, pidStartTime?: number | null): Promise<void> {
    await killPid(pid, this.logger, {
      pidStartTime,
      killTimeoutMs: this.killTimeoutMs,
    });
  }

  /**
   * Kill a process and wait for it to exit, with SIGKILL escalation.
   * Sends SIGTERM, waits up to killTimeoutMs, then escalates to SIGKILL if still alive.
   */
  private async killAndAwaitProc(proc: NonNullable<WsSession["proc"]>): Promise<void> {
    try {
      proc.kill();
    } catch {
      // already dead
      return;
    }
    let timeoutId: Timer | undefined;
    const exited = proc.exited.then(() => "exited" as const);
    const timedOut = new Promise<"timeout">((r) => {
      timeoutId = setTimeout(() => r("timeout"), this.killTimeoutMs);
    });
    const result = await Promise.race([exited, timedOut]);
    clearTimeout(timeoutId);
    if (result === "timeout") {
      this.logger.error("[_claude] Process did not exit after SIGTERM — sending SIGKILL");
      try {
        proc.kill(9);
      } catch {
        // already dead
        return;
      }
      let sigkillTimeoutId: Timer | undefined;
      const sigkillTimeout = new Promise<void>((r) => {
        sigkillTimeoutId = setTimeout(r, KILL_SIGKILL_GRACE_MS);
      });
      await Promise.race([proc.exited, sigkillTimeout]);
      clearTimeout(sigkillTimeoutId);
    }
  }

  /**
   * Clear a session by killing the claude process and respawning.
   * Gives a truly fresh context without losing the session entry.
   * Idempotent — if a clear is already in progress, this is a no-op.
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    // Reentrancy guard — if already clearing (e.g. rapid /clear), skip.
    // The in-flight clear will respawn once the process exits.
    if (session.clearing) return;
    session.clearing = true;
    session.workCompleted = false;

    // Reset state machine (preserves cumulative cost/tokens)
    const events = session.state.resetForClear();
    for (const event of events) {
      this.onSessionEvent?.(sessionId, event);
      try {
        this.handleSessionEvent(sessionId, session, event);
      } catch (err) {
        this.logger.error(
          `[_claude] handleSessionEvent failed for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
        );
      }
    }

    // Clear connect timeout timer
    if (session.connectTimer) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }

    // Clear keep-alive timer
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // Close WebSocket
    if (session.ws?.readyState === WS_OPEN) {
      try {
        session.ws.close(1000, "Session cleared");
      } catch {
        /* already dead */
      }
    }
    session.ws = null;

    // Kill process and wait for exit before respawning.
    // Null the ref first so the proc.exited handler (which checks session.proc !== proc)
    // skips the stale exit — we're about to respawn.
    if (session.proc) {
      const dying = session.proc;
      session.proc = null;
      session.spawnAlive = false;
      await this.killAndAwaitProc(dying);
    }

    // Guard: if the session was terminated (bye/stop) during the kill await, bail out.
    // terminateSession already cleaned everything up — don't respawn into a dead session.
    if (!this.sessions.has(sessionId)) return;

    // Update config prompt to empty — next sendPrompt() will carry real work
    session.config.prompt = "";

    // Clear transcript for fresh start
    session.transcript.length = 0;

    // Respawn — reuse stored traceparent to maintain trace continuity across clears
    this.spawnClaude(sessionId, session.traceparent ?? undefined);
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
      try {
        this.handleSessionEvent(sessionId, session, event);
      } catch (err) {
        this.logger.error(
          `[_claude] handleSessionEvent failed for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
        );
      }
    }
  }

  /**
   * Gracefully end a session: close WS, stop process, clean up. Returns worktree info.
   * Awaits process exit (SIGTERM → SIGKILL escalation), so may take up to ~7s if the
   * process is stuck. Callers that need a fast return should fire-and-forget this.
   */
  async bye(
    sessionId: string,
    message?: string,
  ): Promise<{ worktree: string | null; cwd: string | null; repoRoot: string | null }> {
    const resolvedId = this.resolveSessionId(sessionId);
    const session = this.sessions.get(resolvedId);
    if (!session) throw new Error(`No session with id ${resolvedId}`);

    // Log the closing message to the transcript so it appears in `mcx claude log`
    if (message) {
      this.addTranscript(session, "outbound", {
        type: "user",
        message: { role: "user", content: `[bye] ${message}` },
      });
    }

    const info = {
      worktree: session.worktree,
      cwd: session.config.cwd ?? null,
      repoRoot: session.config.repoRoot ?? null,
    };
    const reason = message ? `Session ended: ${message}` : "Session ended by user";
    await this.terminateSession(resolvedId, session, reason);
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
    const resolvedId = this.resolveSessionId(sessionId);
    const session = this.getSession(resolvedId);
    return {
      ...this.buildSessionInfo(resolvedId, session),
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
  waitForEvent(sessionId: string | null, timeoutMs: number, signal?: AbortSignal): Promise<SessionWaitEvent> {
    const { error, resolvedId } = this.validateWaitTarget(sessionId);
    if (error) return Promise.reject(error);

    // Check if any matching session already has an actionable state
    const immediate = this.findImmediateEvent(resolvedId);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<SessionWaitEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId: resolvedId,
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

      // Support cancellation via AbortSignal (used by --any race cleanup)
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(waiter.timer);
            const idx = this.eventWaiters.indexOf(waiter);
            if (idx >= 0) this.eventWaiters.splice(idx, 1);
          },
          { once: true },
        );
      }

      this.eventWaiters.push(waiter);
    });
  }

  /**
   * Cursor-based event wait: return buffered events after `afterSeq`, or block until one arrives.
   * On timeout, returns `{ seq: currentSeq, events: [] }` instead of throwing.
   */
  waitForEventsSince(
    sessionId: string | null,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    const { error, resolvedId } = this.validateWaitTarget(sessionId);
    if (error) return Promise.reject(error);

    // Check buffer for events after afterSeq
    const buffered = this.getBufferedEventsAfter(resolvedId, afterSeq);
    if (buffered.length > 0) {
      return Promise.resolve({ seq: this.eventSeq, events: buffered });
    }

    // Check if any matching session already has an actionable state (idle, pending permission).
    // This is critical: if the session went idle but the result event's seq is at or before
    // afterSeq (already consumed), the buffer check above returns nothing. Without this
    // immediate check, the wait blocks until timeout even though the session is idle.
    const immediate = this.findImmediateEvent(resolvedId);
    if (immediate) {
      return Promise.resolve({ seq: this.eventSeq, events: [immediate] });
    }

    // Block until next matching event
    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId: resolvedId,
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

      // Support cancellation via AbortSignal (used by --any race cleanup)
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(waiter.timer);
            const idx = this.eventWaiters.indexOf(waiter);
            if (idx >= 0) this.eventWaiters.splice(idx, 1);
          },
          { once: true },
        );
      }

      this.eventWaiters.push(waiter);
    });
  }

  // ── Work item event support ──

  /**
   * Wait for the next work item event matching the given filters.
   * Used by `mcx wait --pr` and `mcx wait --checks`.
   */
  waitForWorkItemEvent(
    prNumber: number | null,
    checksOnly: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkItemWaitEvent> {
    // Check buffer for a matching event that arrived before the waiter was registered
    const buffered = this.findBufferedWorkItemEvent(prNumber, checksOnly);
    if (buffered) return Promise.resolve(buffered);

    return new Promise<WorkItemWaitEvent>((resolve, reject) => {
      const waiter: WorkItemWaiter = {
        prNumber,
        checksOnly,
        resolve: (e) => {
          clearTimeout(waiter.timer);
          resolve(e);
        },
        reject: (e) => {
          clearTimeout(waiter.timer);
          reject(e);
        },
        timer: setTimeout(() => {
          const idx = this.workItemWaiters.indexOf(waiter);
          if (idx >= 0) this.workItemWaiters.splice(idx, 1);
          reject(new WaitTimeoutError(`Timeout waiting for work item event after ${timeoutMs}ms`));
        }, timeoutMs),
      };

      // Support cancellation via AbortSignal (used by --any race cleanup)
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(waiter.timer);
            const idx = this.workItemWaiters.indexOf(waiter);
            if (idx >= 0) this.workItemWaiters.splice(idx, 1);
          },
          { once: true },
        );
      }

      this.workItemWaiters.push(waiter);
    });
  }

  /**
   * Dispatch a work item event from the poller. Resolves any matching work item waiters.
   * Called from the worker's control message handler when the main thread forwards events.
   */
  dispatchWorkItemEvent(event: WorkItemEvent): void {
    const waitEvent: WorkItemWaitEvent = { source: "work_item", workItemEvent: event };
    const eventPrNumber = "prNumber" in event ? event.prNumber : null;
    const remaining: WorkItemWaiter[] = [];
    for (const waiter of this.workItemWaiters) {
      const matchesPr = waiter.prNumber === null || (eventPrNumber !== null && waiter.prNumber === eventPrNumber);
      const matchesChecks = !waiter.checksOnly || event.type.startsWith("checks:");
      if (matchesPr && matchesChecks) {
        waiter.resolve(waitEvent);
      } else {
        remaining.push(waiter);
      }
    }
    this.workItemWaiters.length = 0;
    this.workItemWaiters.push(...remaining);

    // Buffer the event so waiters registered after dispatch can still see it
    this.workItemBuffer.push({ event: waitEvent, ts: Date.now() });
    this.trimWorkItemBuffer();
  }

  /** Find and consume a buffered work item event matching the given filters. */
  private findBufferedWorkItemEvent(prNumber: number | null, checksOnly: boolean): WorkItemWaitEvent | null {
    this.trimWorkItemBuffer();
    for (let i = 0; i < this.workItemBuffer.length; i++) {
      const entry = this.workItemBuffer[i];
      const event = entry.event.workItemEvent;
      const eventPrNumber = "prNumber" in event ? event.prNumber : null;
      const matchesPr = prNumber === null || (eventPrNumber !== null && prNumber === eventPrNumber);
      const matchesChecks = !checksOnly || event.type.startsWith("checks:");
      if (matchesPr && matchesChecks) {
        // Consume — remove from buffer so the same event isn't returned twice
        this.workItemBuffer.splice(i, 1);
        return entry.event;
      }
    }
    return null;
  }

  private trimWorkItemBuffer(): void {
    const cutoff = Date.now() - WORK_ITEM_BUFFER_TTL_MS;
    let dropCount = Math.max(0, this.workItemBuffer.length - MAX_WORK_ITEM_BUFFER);
    while (dropCount < this.workItemBuffer.length && this.workItemBuffer[dropCount].ts < cutoff) {
      dropCount++;
    }
    if (dropCount > 0) this.workItemBuffer.splice(0, dropCount);
  }

  // ── WebSocket handlers ──

  /**
   * Full WebSocket disconnection cleanup. Must be called from every error path
   * that detects a broken WS — not just handleClose.
   */
  private disconnectSessionWs(sessionId: string, session: WsSession, reason: string): void {
    const prevState = session.state.state;
    session.ws = null;

    // Dispose immediately — handleSessionEvent is not invoked from this path,
    // so the session:disconnected case there would never fire.
    this.disposeStuckDetector(session);

    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // If work is done and the process is dead, auto-terminate instead of
    // leaving a zombie disconnected entry.
    if (session.workCompleted && !session.spawnAlive) {
      this.logger.info(`[_claude] Auto-terminating completed session ${sessionId} on WS disconnect (spawn dead)`);
      this.terminateSession(sessionId, session, "WS disconnected after completion").catch((err) => {
        this.logger.error(`[_claude] Auto-terminate failed for ${sessionId}: ${err}`);
      });
      return;
    }

    // Transition state if not already ended/disconnected/clearing
    if (prevState !== "ended" && prevState !== "disconnected" && !session.clearing) {
      const events = session.state.disconnect(reason);
      for (const event of events) {
        this.onSessionEvent?.(sessionId, event);
      }
    }

    // Reject pending result waiters — they can't get results without WS
    for (const waiter of session.resultWaiters) {
      waiter.reject(new Error("WebSocket disconnected"));
    }
    session.resultWaiters.length = 0;
  }

  private handleOpen(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.close(1008, "Unknown session");
      return;
    }

    // Clear the connect timeout — WS connection established successfully
    if (session.connectTimer) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }

    session.ws = ws;

    const isReconnect = session.state.state === "disconnected";

    // If reconnecting from disconnected state, transition back to connecting
    if (isReconnect) {
      this.logger.info(`[_claude] WebSocket reconnected for session ${sessionId}`);
      session.state.reconnect();
    }

    // Only send the initial user message on fresh connections.
    // Reconnecting sessions already have their conversation state — resending
    // the original prompt would inject an empty/stale message into the stream.
    if (!isReconnect) {
      // CRITICAL: Send the initial user message immediately.
      // The CLI will NOT send system/init until it receives a user message.
      const prompt = session.config.prompt;
      const outbound = userMessage(prompt, sessionId);
      try {
        ws.send(outbound);
      } catch (err) {
        this.logger.error(`[_claude] WebSocket send failed on open for session ${sessionId}: ${err}`);
        this.disconnectSessionWs(sessionId, session, "WebSocket send failed on open");
        // Kill the spawned process — it can't communicate without WS
        if (session.proc) {
          try {
            session.proc.kill();
          } catch {
            /* already dead */
          }
        }
        return;
      }
      this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: prompt } });
    }

    // Start keep-alive
    session.keepAliveTimer = setInterval(() => {
      if (session.ws?.readyState === WS_OPEN) {
        try {
          session.ws.send(keepAlive());
        } catch (err) {
          this.logger.error(`[_claude] WebSocket keep-alive send failed for session ${sessionId}: ${err}`);
          this.disconnectSessionWs(sessionId, session, "WebSocket keep-alive send failed");
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
      this.logger.error(`[_claude] Failed to parse NDJSON from session ${sessionId}`);
      return;
    }

    for (const msg of messages) {
      this.addTranscript(session, "inbound", msg);
      const events = session.state.handleMessage(msg);

      // Log when a fallback schema was used — the strict schema didn't match
      // but we still extracted what we could and kept working.
      if (session.state.parseMismatch) {
        this.logger.error(
          `[_claude] Schema mismatch for session ${sessionId}: ${msg.type}` +
            `${msg.subtype ? `/${msg.subtype}` : ""} used fallback parsing ` +
            `(state: "${session.state.state}", keys: ${Object.keys(msg).join(", ")})`,
        );
      }

      // tool_progress and stream_event are ignored by the state machine but
      // represent active execution — treat them as progress to prevent false
      // stuck-detector fires during long-running tools or streaming responses.
      if (msg.type === "tool_progress" || msg.type === "stream_event") {
        this.recordSessionProgress(sessionId, session);
      }

      // Log unrecognized message types (not in IGNORED_TYPES, not a known handler).
      // This helps detect new CLI message types that the daemon should handle.
      if (events.length === 0 && !session.state.parseMismatch && !KNOWN_MSG_TYPES.has(msg.type)) {
        this.logger.error(
          `[_claude] Unrecognized message type "${msg.type}" from session ${sessionId} — ` +
            `message was silently dropped. Keys: ${Object.keys(msg).join(", ")}`,
        );
      }

      // Warn if a result message produced no events — even the fallback failed.
      if (msg.type === "result" && events.length === 0) {
        this.logger.error(
          `[_claude] Result message for session ${sessionId} produced no events even after fallback — ` +
            `session stuck in "${session.state.state}" state. Keys: ${Object.keys(msg).join(", ")}`,
        );
      }

      for (const event of events) {
        try {
          this.onSessionEvent?.(sessionId, event);
        } catch (err) {
          this.logger.error(
            `[_claude] onSessionEvent callback threw for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
          );
        }
        try {
          this.handleSessionEvent(sessionId, session, event);
        } catch (err) {
          this.logger.error(
            `[_claude] handleSessionEvent failed for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
          );
        }
      }
    }
  }

  private handleClose(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.error(
      `[_claude] WebSocket disconnected for session ${sessionId} (spawn ${session.spawnAlive ? "alive" : "dead"})`,
    );

    this.disconnectSessionWs(sessionId, session, "WebSocket closed");
  }

  // ── Event handling ──

  private handleSessionEvent(sessionId: string, session: WsSession, event: SessionEvent): void {
    const logErr = (label: string, err: unknown) =>
      this.logger.error(
        `[_claude] ${label} for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
      );

    switch (event.type) {
      case "session:init":
        // Capture Claude Code's own session ID for JSONL file lookup
        session.claudeSessionId = event.sessionId;
        this.recordSessionProgress(sessionId, session);
        break;
      case "session:response":
        this.recordSessionProgress(sessionId, session);
        break;
      case "session:permission_request":
        session.pendingImmediate = true;
        this.recordSessionProgress(sessionId, session);
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:permission_request",
            requestId: event.requestId,
            toolName: event.request.tool_name,
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        this.handlePermissionRequest(sessionId, session, event.requestId, event.request).catch((err) => {
          this.logger.error(
            `[_claude] Permission evaluation failed for session ${sessionId}: ${err instanceof Error ? err.stack : err}`,
          );
        });
        break;
      case "session:result":
        session.pendingImmediate = true;
        session.workCompleted = true;
        this.disposeStuckDetector(session);
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:result",
            cost: event.cost,
            tokens: event.tokens,
            numTurns: event.numTurns,
            result: event.result,
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        try {
          this.resolveWaiters(session, {
            sessionId,
            success: true,
            result: event.result,
            cost: event.cost,
            tokens: event.tokens,
            numTurns: event.numTurns,
          });
        } catch (err) {
          logErr("resolveWaiters failed", err);
        }
        break;
      case "session:error":
        session.pendingImmediate = true;
        session.workCompleted = true;
        this.disposeStuckDetector(session);
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:error",
            cost: event.cost,
            errors: event.errors,
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        try {
          this.resolveWaiters(session, {
            sessionId,
            success: false,
            errors: event.errors,
            cost: event.cost,
            tokens: 0,
            numTurns: 0,
          });
        } catch (err) {
          logErr("resolveWaiters failed", err);
        }
        break;
      case "session:cleared":
        this.disposeStuckDetector(session);
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:cleared",
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        break;
      case "session:model_changed":
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:model_changed",
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        break;
      case "session:rate_limited":
        session.pendingImmediate = true;
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:rate_limited",
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        break;
      case "session:disconnected":
        this.disposeStuckDetector(session);
        try {
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: "session:disconnected",
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        break;
      case "session:containment_warning":
      case "session:containment_denied":
      case "session:containment_escalated":
        this.logger.warn(`[_claude] Containment ${event.type.split(":")[1]} for session ${sessionId}: ${event.reason}`);
        try {
          session.pendingImmediate = true;
          this.resolveEventWaiters(sessionId, {
            sessionId,
            event: event.type,
            toolName: event.toolName,
            result: event.reason,
            strikes: event.strikes,
          });
        } catch (err) {
          logErr("resolveEventWaiters failed", err);
        }
        break;
    }

    this.publishSessionMonitorEvent(sessionId, event);
  }

  private static readonly SESSION_EVENT_MAP: Record<string, string> = {
    "session:permission_request": SESSION_PERMISSION_REQUEST,
    "session:result": SESSION_RESULT,
    "session:error": SESSION_ERROR,
    "session:cleared": SESSION_CLEARED,
    "session:model_changed": SESSION_MODEL_CHANGED,
    "session:rate_limited": SESSION_RATE_LIMITED,
    "session:disconnected": SESSION_DISCONNECTED,
    "session:ended": SESSION_ENDED,
    "session:containment_warning": SESSION_CONTAINMENT_WARNING,
    "session:containment_denied": SESSION_CONTAINMENT_DENIED,
    "session:containment_escalated": SESSION_CONTAINMENT_ESCALATED,
    "session:containment_reset": SESSION_CONTAINMENT_RESET,
  };

  private publishSessionMonitorEvent(sessionId: string, event: SessionEvent): void {
    if (!this.onMonitorEvent) return;
    const mapped = ClaudeWsServer.SESSION_EVENT_MAP[event.type];
    if (!mapped) return;

    const input: MonitorEventInput = {
      src: "daemon.claude-server",
      event: mapped,
      category: "session",
      sessionId,
    };

    if ("cost" in event) input.cost = event.cost;
    if ("tokens" in event) input.tokens = event.tokens;
    if ("numTurns" in event) input.numTurns = event.numTurns;
    if ("result" in event) input.result = event.result;
    if ("result" in event && typeof event.result === "string") {
      const flat = event.result.replace(/\n/g, " ");
      input.resultPreview = flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
    }
    if ("errors" in event) input.errors = event.errors;
    if ("requestId" in event) input.requestId = event.requestId;
    if ("toolName" in event) input.toolName = event.toolName;
    if (event.type === "session:permission_request") input.toolName = event.request.tool_name;
    if ("model" in event) input.model = (event as { model: string }).model;
    if ("strikes" in event) input.strikes = event.strikes;
    if ("reason" in event) input.reason = event.reason;

    this.onMonitorEvent(input);

    if (event.type === "session:result") {
      const idleInput: MonitorEventInput = {
        src: "daemon.claude-server",
        event: SESSION_IDLE,
        category: "session",
        sessionId,
      };
      if ("cost" in event) idleInput.cost = event.cost;
      if ("tokens" in event) idleInput.tokens = event.tokens;
      if ("numTurns" in event) idleInput.numTurns = event.numTurns;
      if (input.resultPreview !== undefined) idleInput.resultPreview = input.resultPreview;
      this.onMonitorEvent(idleInput);
    }
  }

  private static readonly WORK_ITEM_EVENT_MAP: Record<string, string> = {
    "pr:opened": PR_OPENED,
    "pr:pushed": PR_PUSHED,
    "pr:merged": PR_MERGED,
    "pr:closed": PR_CLOSED,
    "checks:started": CHECKS_STARTED,
    "checks:passed": CHECKS_PASSED,
    "checks:failed": CHECKS_FAILED,
    "review:approved": REVIEW_APPROVED,
    "review:changes_requested": REVIEW_CHANGES_REQUESTED,
    "phase:changed": PHASE_CHANGED,
    "pr:merge_state_changed": PR_MERGE_STATE_CHANGED,
  };

  private publishWorkItemMonitorEvent(event: WorkItemEvent): void {
    if (!this.onMonitorEvent) return;
    const mapped = ClaudeWsServer.WORK_ITEM_EVENT_MAP[event.type];
    if (!mapped) return;

    const input: MonitorEventInput = {
      src: "daemon.work-item-poller",
      event: mapped,
      category: "work_item",
    };

    if ("prNumber" in event) input.prNumber = event.prNumber;
    if ("failedJob" in event) input.failedJob = event.failedJob;
    if ("reviewer" in event) input.reviewer = event.reviewer;
    if ("itemId" in event) input.workItemId = event.itemId;
    if ("from" in event) input.from = event.from;
    if ("to" in event) input.to = event.to;
    if ("runId" in event) input.runId = event.runId;
    if ("branch" in event) input.branch = event.branch;
    if ("base" in event) input.base = event.base;
    if ("commits" in event) input.commits = event.commits;
    if ("srcChurn" in event) input.srcChurn = event.srcChurn;
    if ("mergeSha" in event) input.mergeSha = event.mergeSha;
    if ("filesTruncated" in event) input.filesTruncated = event.filesTruncated;
    if ("cascadeHead" in event) input.cascadeHead = event.cascadeHead;

    this.onMonitorEvent(input);
  }

  private async handlePermissionRequest(
    sessionId: string,
    session: WsSession,
    requestId: string,
    request: CanUseToolRequest,
  ): Promise<void> {
    // Containment check — runs before permission router for worktree sessions
    if (session.containment) {
      const result = session.containment.evaluate(request.tool_name, request.input);
      if (result.event) {
        const containmentEvent = {
          type: result.event,
          toolName: request.tool_name,
          reason: result.reason,
          strikes: result.strikes,
        } as const;
        this.handleSessionEvent(sessionId, session, containmentEvent);
      }
      if (result.action === "deny") {
        session.state.respondToPermission(requestId, false, result.reason);
        this.sendToWs(
          session,
          permissionDeny(requestId, result.reason, result.event === "session:containment_escalated"),
        );
        return;
      }
    }

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

  // ── Stuck detection (#1585) ──

  private ensureStuckDetector(sessionId: string, session: WsSession): StuckDetector {
    if (!session.stuckDetector || session.stuckDetector.isDisposed) {
      session.stuckDetector = new StuckDetector(
        sessionId,
        this.stuckConfig,
        () => ({
          state: session.state.state,
          tokens: session.state.tokens,
          lastToolCall: session.state.lastToolCall,
          pendingPermissionCount: session.state.pendingPermissions.size,
          hasActiveToolCall: session.state.hasActiveToolCall,
        }),
        (event) => this.handleStuckEvent(sessionId, session, event),
      );
    }
    return session.stuckDetector;
  }

  private recordSessionProgress(sessionId: string, session: WsSession): void {
    const detector = this.ensureStuckDetector(sessionId, session);
    detector.recordProgress(session.state.tokens);
  }

  private disposeStuckDetector(session: WsSession): void {
    if (session.stuckDetector) {
      session.stuckDetector.dispose();
      session.stuckDetector = null;
    }
  }

  private handleStuckEvent(sessionId: string, session: WsSession, event: StuckEvent): void {
    const workItemId = session.config.worktree ?? undefined;

    try {
      this.resolveEventWaiters(sessionId, {
        sessionId,
        event: "session:stuck",
        tier: event.tier,
        sinceMs: event.sinceMs,
        tokenDelta: event.tokenDelta,
        lastTool: event.lastTool,
        lastToolError: event.lastToolError,
      });

      if (this.onMonitorEvent) {
        this.onMonitorEvent({
          src: "daemon.claude-server",
          event: SESSION_STUCK,
          category: "session",
          sessionId,
          workItemId,
          tier: event.tier,
          sinceMs: event.sinceMs,
          tokenDelta: event.tokenDelta,
          lastTool: event.lastTool,
          lastToolError: event.lastToolError,
        });
      }
    } catch (err) {
      this.logger.error(
        `[_claude] Failed to handle stuck session event for ${sessionId}: ${err instanceof Error ? err.stack : err}`,
      );
    }
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

      // Only return immediate events that haven't been reported yet.
      // This prevents wait from returning the same stale idle session on every call,
      // which caused wait to act like ls after daemon restarts (#985).
      if (!session.pendingImmediate) continue;

      if (session.state.state === "idle") {
        session.pendingImmediate = false;
        return {
          sessionId: sid,
          event: "session:result",
          cost: session.state.cost,
          tokens: session.state.tokens,
          numTurns: session.state.numTurns,
          session: this.buildSessionInfo(sid, session),
        };
      }

      if (session.state.state === "waiting_permission" && session.state.pendingPermissions.size > 0) {
        const entry = session.state.pendingPermissions.entries().next().value;
        if (!entry) continue;
        const [requestId, req] = entry;
        session.pendingImmediate = false;
        return {
          sessionId: sid,
          event: "session:permission_request",
          requestId,
          toolName: req.tool_name,
          session: this.buildSessionInfo(sid, session),
        };
      }
    }
    return null;
  }

  /** Validate that a wait target (sessionId or any-session) is valid. Returns null if OK, Error otherwise. */
  private validateWaitTarget(sessionId: string | null): { error?: Error; resolvedId: string | null } {
    if (sessionId) {
      let resolvedId: string;
      try {
        resolvedId = this.resolveSessionId(sessionId);
      } catch (e) {
        return { error: e as Error, resolvedId: null };
      }
      const session = this.sessions.get(resolvedId);
      if (session?.state.state === "ended") return { error: new Error("Session already ended"), resolvedId: null };
      if (session?.state.state === "disconnected")
        return { error: new Error("Session is disconnected"), resolvedId: null };
      return { resolvedId };
    }
    if (this.sessions.size === 0) {
      return { error: new Error("No active sessions"), resolvedId: null };
    }
    return { resolvedId: null };
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

  /**
   * Resolve a session ID or unique prefix to the full session ID.
   * Throws if zero or multiple sessions match.
   */
  resolveSessionId(sessionId: string): string {
    if (this.sessions.has(sessionId)) return sessionId;

    const matches: string[] = [];
    for (const id of this.sessions.keys()) {
      if (id.startsWith(sessionId)) matches.push(id);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous session prefix "${sessionId}" — matches: ${matches.join(", ")}`);
    }
    throw new Error(`Unknown session: ${sessionId}`);
  }

  private getSession(sessionId: string): WsSession {
    const resolved = this.resolveSessionId(sessionId);
    const session = this.sessions.get(resolved);
    if (!session) throw new Error(`Unknown session: ${resolved}`);
    return session;
  }

  private buildSessionInfo(sessionId: string, s: WsSession): SessionInfo {
    const details: AgentPermissionRequest[] = [];
    for (const [reqId, req] of s.state.pendingPermissions) {
      details.push({
        requestId: reqId,
        toolName: req.tool_name,
        input: req.input,
        inputSummary: summarizeInput(req.input),
      });
    }
    return {
      sessionId,
      name: s.name,
      provider: "claude",
      state: s.state.state,
      model: s.state.model,
      cwd: s.state.cwd,
      cost: s.state.cost,
      tokens: s.state.tokens,
      reasoningTokens: 0,
      numTurns: s.state.numTurns,
      pendingPermissions: s.state.pendingPermissions.size,
      pendingPermissionDetails: details,
      worktree: s.config.worktree ?? null,
      repoRoot: s.config.repoRoot ?? null,
      processAlive: s.spawnAlive,
      rateLimited: s.state.rateLimited,
      createdAt: s.createdAt,
      wsConnected: s.ws !== null,
      spawnAlive: s.spawnAlive,
      snapshotTs: Date.now(),
    };
  }

  /** Generate a unique session name by checking names already in use. */
  private generateName(): string {
    const usedNames = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.name) usedNames.add(s.name);
    }
    return generateSessionName(usedNames);
  }

  private sendToWs(session: WsSession, message: string): void {
    if (session.ws?.readyState === WS_OPEN) {
      try {
        session.ws.send(message);
      } catch (err) {
        this.logger.error(`[_claude] WebSocket send failed: ${err}`);
        // Find sessionId for this session
        for (const [sid, s] of this.sessions) {
          if (s === session) {
            this.disconnectSessionWs(sid, session, "WebSocket send failed");
            break;
          }
        }
      }
    }
  }

  private addTranscript(session: WsSession, direction: "inbound" | "outbound", message: NdjsonMessage): void {
    if (message.type === "keep_alive") return;
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
    // Attach full session snapshot so consumers don't need a follow-up list call.
    // IMPORTANT: event.session MUST be set here, before bufferEvent(), because
    // bufferEvent() does a shallow spread ({ ...event, seq }) — if session is not
    // yet on the event object, the buffered copy will be missing it too.
    const session = this.sessions.get(sessionId);
    if (session) {
      event.session = this.buildSessionInfo(sessionId, session);
    }

    // Buffer the event with a sequence number (before resolving waiters)
    this.bufferEvent(event);

    const remaining: EventWaiter[] = [];
    let delivered = false;
    for (const waiter of this.eventWaiters) {
      if (waiter.sessionId === null || waiter.sessionId === sessionId) {
        // Resolve with the buffered (seq-tagged) version
        const latest = this.eventBuffer[this.eventBuffer.length - 1];
        waiter.resolve(latest.event);
        delivered = true;
      } else {
        remaining.push(waiter);
      }
    }
    this.eventWaiters.length = 0;
    this.eventWaiters.push(...remaining);

    // If event was delivered to at least one waiter, clear the flag so
    // findImmediateEvent won't return this stale event to the next caller.
    if (delivered && session) {
      session.pendingImmediate = false;
    }
  }

  /**
   * Single cleanup path: end state machine, drain waiters, clear timers,
   * close WS, kill process, remove from sessions map.
   */
  private async terminateSession(sessionId: string, session: WsSession, errorMessage: string): Promise<void> {
    // Dispose stuck detector before ending
    this.disposeStuckDetector(session);

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

    // Clear connect timeout timer
    if (session.connectTimer) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }

    // Clear keep-alive timer
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }

    // Close WebSocket
    if (session.ws?.readyState === WS_OPEN) {
      try {
        session.ws.close(1000, "Session ended");
      } catch {
        /* already dead */
      }
    }
    session.ws = null;

    // Kill process and await exit.
    // Null refs first so the proc.exited handler skips the stale exit
    // and no other path can signal a recycled PID.
    if (session.proc) {
      const dying = session.proc;
      session.proc = null;
      session.pid = null;
      session.spawnAlive = false;
      await this.killAndAwaitProc(dying);
    } else if (session.pid) {
      // Restored sessions have no proc ref but may still have a live process.
      // Use killRawPid for SIGTERM → SIGKILL escalation (matches killAndAwaitProc behavior).
      // Pass pidStartTime to verify the PID hasn't been recycled by the OS.
      const pid = session.pid;
      session.pid = null;
      await this.killRawPid(pid, session.pidStartTime);
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

// ── Stderr drain ──

const MAX_STDERR_LINES = 50;

/**
 * Actively consume a stderr ReadableStream into a ring buffer of lines.
 *
 * CRITICAL: Without this, piped stderr fills the OS pipe buffer (64KB on macOS)
 * and the child process blocks on the next write — deadlocking before it can
 * connect via WebSocket. This is the fix for #546.
 */
async function drainStderr(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length === 0) continue;
        lines.push(line);
        if (lines.length > MAX_STDERR_LINES) lines.shift();
      }
    }
    // Flush any remaining partial line
    if (partial.length > 0) {
      lines.push(partial);
      if (lines.length > MAX_STDERR_LINES) lines.shift();
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Helpers ──

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "EADDRINUSE";
}

// ── Default spawn ──

function defaultSpawn(
  cmd: string[],
  opts: {
    cwd?: string;
    stdout?: "ignore" | "pipe";
    stderr?: "ignore" | "pipe";
    stdin?: "ignore" | "pipe";
    env?: Record<string, string | undefined>;
  },
): {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: number) => void;
  stderr?: ReadableStream<Uint8Array> | null;
} {
  // Strip CLAUDECODE env var so the spawned claude process doesn't think
  // it's a nested session and refuse to start.
  const env = { ...process.env, ...opts.env };
  env.CLAUDECODE = undefined;
  // Shells set PWD on cd; Bun.spawn only does chdir(). Without this,
  // the spawned process inherits the daemon's PWD and tools that read
  // $PWD (instead of getcwd()) operate in the wrong directory.
  if (opts.cwd) {
    env.PWD = opts.cwd;
  }

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
    stderr: proc.stderr,
  };
}
