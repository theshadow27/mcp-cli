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
import { dirname, join } from "node:path";
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
  CONTAINMENT_WRITE_TOOLS,
  ContainmentGuard,
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
  SESSION_PERMISSION_BLOCKED,
  SESSION_PERMISSION_REQUEST,
  SESSION_RESULT,
  SESSION_SPAWN_OVERRIDE,
  SESSION_STUCK,
  SESSION_TOOL_USE,
  WORKER_RATELIMITED,
  consoleLogger,
  findGitRoot,
  generateSessionName,
  spawnManaged,
} from "@mcp-cli/core";
import type { ServerWebSocket } from "bun";
import { killPid, reapWorktreeProcesses } from "../process-util";
import { safeSetInterval, safeSetTimeout } from "../safe-timers";
import type { NdjsonMessage } from "./ndjson";
import { keepAlive, parseFrame, permissionAllow, permissionDeny, setModelRequest, userMessage } from "./ndjson";
import type { CanUseToolRequest, PermissionRule, PermissionStrategy } from "./permission-router";
import { PermissionRouter } from "./permission-router";
import type { SessionEvent } from "./session-state";
import { IGNORED_TYPES, SessionState } from "./session-state";
import {
  DEFAULT_STUCK_CONFIG,
  REAL_CLOCK,
  StuckDetector,
  type StuckDetectorClock,
  type StuckDetectorConfig,
  type StuckEvent,
} from "./stuck-detector";

// ── Constants ──

/** Time (ms) to wait after SIGTERM before escalating to SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;
/** Time (ms) to wait after SIGKILL before giving up. */
const KILL_SIGKILL_GRACE_MS = 2_000;
/** Time (ms) to wait for a WebSocket connection after spawning a Claude CLI process. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Max chars retained in the unterminated child-stderr line buffer before it is
 * force-flushed in slices, bounding memory for a child that never emits a
 * newline (#2769). 64 KiB matches the spawnManaged stderr ring default. */
const MAX_STDERR_LINE_CHARS = 64 * 1024;

/** Message types handled by the state machine's dispatch. */
const HANDLED_MSG_TYPES: ReadonlyArray<string> = [
  "system",
  "assistant",
  "result",
  "control_request",
  "rate_limit_event",
];

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
  /**
   * Resolved transport for this session: `"ws"` (sdk-url WebSocket) or `"stdio"` (pipe).
   * Resolved from CliConfig.transport + claude version at spawn time.
   * Default: `"ws"` (preserves legacy behavior).
   */
  transport?: "ws" | "stdio";
  /**
   * Per-session claude binary override (#2681). When set, this binary is spawned
   * instead of the daemon's startup-resolved `binaryPath`, and the global
   * spawn-disabled guard is bypassed (the caller vouches for this binary).
   * Used by `mcx claude spawn --claude-binary <path>` to canary a binary on a
   * single worker without mutating global config.
   */
  binaryPath?: string;
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
    /** Real-time tap on decoded child stderr chunks (only when stderr === "pipe"). */
    onStderr?: (chunk: string) => void;
    /** Called once after the child stderr stream drains — flush trailing partial line. */
    onStderrEnd?: () => void;
  },
) => {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: number) => void;
  stderr?: ReadableStream<Uint8Array> | null;
  stderrTail?: () => string;
  /** Readable stdout stream — present when opts.stdout === "pipe". Used by stdio transport. */
  stdout?: ReadableStream<Uint8Array> | null;
  /** Writable stdin sink — present when opts.stdin === "pipe". Used by stdio transport. */
  stdin?: { write(data: string | Uint8Array): number | Promise<number>; flush(): number | Promise<number> } | null;
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
  /** When pid was captured (epoch ms) — fresh caches skip jittery isOurProcess (#2437). */
  pidCachedAt: number | null;
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
  /** Transport mode for this session. "ws" = WebSocket (sdk-url), "stdio" = pipes. */
  transport: "ws" | "stdio";
  /** Writable stdin sink for stdio transport. Null for WS sessions. */
  stdioWriter: { write(data: string | Uint8Array): number | Promise<number>; flush(): number | Promise<number> } | null;
  /**
   * Resolves when the stdio stdout reader has drained to EOF. Awaited in the
   * proc.exited handler before judging completion, so the trailing `result`
   * NDJSON line (still buffered in the pipe at exit) is processed before the
   * session can transit through a premature `disconnected` state (#2825).
   */
  stdioDrainDone?: Promise<void>;
  /**
   * Live stdout reader for the stdio drain loop. Held so teardown paths and the
   * proc.exited handler can `cancel()` it — a grandchild that inherits the child's
   * stdout write fd keeps the pipe open past child exit, so a parked `reader.read()`
   * never sees EOF and `stdioDrainDone` would await forever. Cancelling unblocks the
   * parked read so the drain resolves. Null for WS transport and after the drain ends.
   * (#2833)
   */
  stdioReader: ReadableStreamDefaultReader<Uint8Array> | null;
  /**
   * Resolves the first time work completes (session:result / session:error fires).
   * The proc.exited stdio path races this against `stdioDrainDone` so the handler
   * stops waiting the instant the completion signal is in hand — never on a wall
   * clock — which unblocks the grandchild-holds-fd hang without dropping a buffered
   * result (a wall-clock cap would reintroduce #2825). Re-armed on clearSession. (#2833)
   */
  workCompletedSignal: Promise<void>;
  /** Resolver for {@link workCompletedSignal}; idempotent (re-armed on clearSession). */
  signalWorkCompleted: () => void;
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
   * Turn-scoped: reset on clearSession (respawn) and on each follow-up sendPrompt,
   * mirroring workCompletedSignal — a new turn hasn't completed until its result fires.
   */
  workCompleted: boolean;
  /**
   * The SessionResult captured the last time session:result or session:error fired
   * (the same payload handed to resultWaiters). Retained so waitForResult can trust
   * the sticky workCompleted flag and return the buffered result even after a
   * disconnect flipped transient state to "disconnected"/"ended" — the stdio EPIPE
   * trigger where the child's `result` line arrives after the transport dies (#2858).
   * Reset to null on clearSession (respawn = fresh work cycle), mirroring workCompleted.
   */
  lastResult: SessionResult | null;
  /**
   * Reason provided with the last interrupt call. Prepended to the next sendPrompt
   * so the session sees why it was interrupted before the new instruction.
   * Cleared after it is consumed by sendPrompt or when the session is cleared/ended.
   */
  pendingInterruptReason: string | null;
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

/**
 * Build a one-shot completion signal for a session. `promise` resolves the first
 * time `resolve` is called; subsequent calls are no-ops. Used to let the proc.exited
 * stdio drain stop as soon as work completes, without a wall-clock timeout (#2833).
 */
function makeWorkCompletedSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
  private readonly stuckClock: StuckDetectorClock;
  private eventSeq = 0;
  private readonly eventBuffer: BufferedEvent[] = [];
  private nextRequestId = 1;
  private readonly logger: Logger;

  /** Called when session events occur (for DB updates). */
  onSessionEvent: ((sessionId: string, event: SessionEvent) => void) | null = null;

  /** Called to forward monitor events to the main thread's EventBus (#1567). */
  onMonitorEvent: ((input: MonitorEventInput) => void) | null = null;

  /**
   * Called for each complete stderr line from a spawned child process, keyed by
   * session ID. Forwarded to the main thread for persistence so spawn-failure
   * postmortems are recoverable via `mcx logs <session-id>` (#2738).
   */
  onStderrLine: ((sessionId: string, line: string, timestamp: number) => void) | null = null;

  /**
   * Optional TLS material. When set, `Bun.serve` runs in HTTPS mode and binds
   * on `[::1]` instead of the default. Patched-claude (#1808) requires
   * `wss://` and an IPv6 hostname that maps onto an entry in its allowlist.
   * When null, the server keeps its previous plain-`ws://` behavior — the
   * daemon flips this on once it resolves to a patched binary.
   */
  private readonly tlsConfig: { cert: string; key: string } | null;
  private readonly hostname: string | undefined;

  /**
   * Path of the binary to spawn (default: `"claude"`, looked up via PATH).
   * The daemon overrides this with the patched-binary path when claude is
   * 2.1.120+ (see binary-resolver.ts).
   */
  private readonly binaryPath: string;

  /**
   * If non-null, every spawn attempt throws with this reason instead of
   * actually spawning. Used when the daemon can't resolve a working claude
   * binary at startup (e.g. unsupported version) — read-only operations
   * (list/log/wait) still work, but `claude_spawn` fails fast and clearly.
   */
  private readonly spawnDisabledReason: string | null;

  constructor(deps?: {
    spawn?: SpawnFn;
    killTimeoutMs?: number;
    logger?: Logger;
    portRetryCount?: number;
    portRetryDelayMs?: number;
    reclaimIntervalMs?: number;
    connectTimeoutMs?: number;
    stuckConfig?: StuckDetectorConfig;
    /** Override the StuckDetector clock (tests inject a FakeClock). */
    stuckClock?: StuckDetectorClock;
    /** Self-signed cert + key. When provided, server runs as wss://. */
    tlsConfig?: { cert: string; key: string } | null;
    /** Override the bind hostname. Defaults to `::1` when TLS is set, otherwise unset (Bun default). */
    hostname?: string;
    /** Override the binary used for spawning (default: `"claude"`). */
    binaryPath?: string;
    /** Disable spawn with this reason. Read paths still work. */
    spawnDisabledReason?: string | null;
  }) {
    this.spawn = deps?.spawn ?? defaultSpawn;
    this.killTimeoutMs = deps?.killTimeoutMs ?? KILL_TIMEOUT_MS;
    this.logger = deps?.logger ?? consoleLogger;
    // 5 retries with exponential backoff (50/100/200/400/800ms = 1550ms total
    // across 5 sleeps; the loop also performs 1 initial attempt for 6 binds in
    // the worst case). Down from 10 retries × 500ms = 5000ms. The previous
    // default was the dominant tax on every daemon spawn whenever port 19275
    // was held by another daemon — it contributed ~94s to the test suite via
    // daemon-integration.spec.ts.
    this.portRetryCount = deps?.portRetryCount ?? 5;
    this.portRetryDelayMs = deps?.portRetryDelayMs ?? 50;
    this.reclaimIntervalMs = deps?.reclaimIntervalMs ?? PORT_RECLAIM_INTERVAL_MS;
    this.connectTimeoutMs = deps?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.stuckConfig = deps?.stuckConfig ?? DEFAULT_STUCK_CONFIG;
    this.stuckClock = deps?.stuckClock ?? REAL_CLOCK;
    this.tlsConfig = deps?.tlsConfig ?? null;
    this.hostname = deps?.hostname ?? (this.tlsConfig ? "::1" : undefined);
    this.binaryPath = deps?.binaryPath ?? "claude";
    this.spawnDisabledReason = deps?.spawnDisabledReason ?? null;
  }

  /** True when the server is running in TLS (wss://) mode. */
  get isTls(): boolean {
    return this.tlsConfig !== null;
  }

  /** Current event sequence number (monotonically increasing). */
  get currentSeq(): number {
    return this.eventSeq;
  }

  /** Create a Bun.serve() instance with the WS routing handlers. */
  private createServer(p: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<WsData>({
      port: p,
      ...(this.hostname !== undefined ? { hostname: this.hostname } : {}),
      ...(this.tlsConfig ? { tls: this.tlsConfig } : {}),
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
   *  retries up to portRetryCount times with exponential backoff
   *  (portRetryDelayMs × 2^attempt) before falling back to a random
   *  OS-assigned port on EADDRINUSE. */
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
            // Exponential backoff bounded by portRetryDelayMs × 2^attempt.
            // With defaults (50ms × {1,2,4,8,16}) total wait is ~1.55s across
            // 5 retries, vs the previous fixed 10×500ms = 5s schedule.
            await Bun.sleep(this.portRetryDelayMs * 2 ** attempt);
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
      claudeSessionId?: string | null;
      transport?: "ws" | "stdio";
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

      const restoredSignal = makeWorkCompletedSignal();
      this.sessions.set(s.sessionId, {
        state,
        router,
        ws: null,
        transcript: [],
        config: { prompt: "", worktree: s.worktree ?? undefined },
        name: s.name ?? null,
        pid: s.pid,
        pidStartTime: s.pidStartTime ?? null,
        pidCachedAt: null,
        proc: null,
        spawnAlive: false,
        worktree: s.worktree,
        containment: s.worktree && s.cwd ? new ContainmentGuard(s.cwd) : null,
        resultWaiters: [],
        keepAliveTimer: null,
        clearing: false,
        claudeSessionId: s.claudeSessionId ?? null,
        connectTimer: null,
        createdAt: s.spawnedAt ? new Date(`${s.spawnedAt}Z`).getTime() : Date.now(),
        pendingImmediate: false, // Restored sessions have no new events
        workCompleted: false,
        lastResult: null,
        pendingInterruptReason: null,
        traceparent: null,
        stuckDetector: null,
        transport: s.transport ?? "ws",
        stdioWriter: null,
        stdioReader: null,
        workCompletedSignal: restoredSignal.promise,
        signalWorkCompleted: restoredSignal.resolve,
      });
      restored++;
      this.logger.info(`[_claude] Restored session ${s.sessionId} (state: disconnected, pid: ${s.pid})`);
    }
    return restored;
  }

  /**
   * Revive a disconnected session by spawning a new Claude process with `--resume <claudeSessionId>`.
   * Use when `send` targets a session whose process died (e.g. after daemon restart or sprite shutdown).
   *
   * Transitions the session from "disconnected" → "connecting" so `handleOpen` uses the
   * fresh-connection path, which delivers `session.config.prompt` as the first message.
   * Returns the PID of the spawned process.
   */
  reviveSession(sessionId: string, prompt: string): number {
    const session = this.getSession(sessionId);
    if (session.state.state !== "disconnected") {
      throw new Error(
        `Cannot revive session in state "${session.state.state}" — only disconnected sessions can be revived`,
      );
    }
    if (!session.claudeSessionId) {
      throw new Error(
        "Session has no claude session ID — cannot revive (conversation history unavailable; spawn a new session instead)",
      );
    }

    // Set up config so handleOpen delivers the prompt and resumes conversation history
    session.config.prompt = prompt;
    session.config.resumeSessionId = session.claudeSessionId;
    session.config.cwd = session.state.cwd ?? undefined;

    // Clear stale process references — the old process is dead
    session.proc = null;
    session.spawnAlive = false;
    session.pid = null;
    session.pidStartTime = null;
    session.pidCachedAt = null;

    // Transition disconnected → connecting so handleOpen treats this as a fresh spawn
    // (sends session.config.prompt) rather than a WS reconnect (which skips the initial message).
    session.state.reconnect();

    return this.spawnClaude(sessionId);
  }

  /**
   * Prepare a session for an incoming Claude CLI connection.
   * Call this before spawning the Claude process.
   */
  /** Prepare a session and return the assigned name and resolved transport. */
  prepareSession(sessionId: string, config: SessionConfig): { name: string; transport: "ws" | "stdio" } {
    const state = new SessionState(sessionId);
    // Pre-populate state.cwd from config so session info shows the correct
    // cwd even if the Claude process never connects (#1836).
    if (config.cwd) state.cwd = config.cwd;
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
    const resolvedTransport = config.transport ?? "ws";
    const completionSignal = makeWorkCompletedSignal();

    this.sessions.set(sessionId, {
      state,
      router,
      ws: null,
      transcript: [],
      config,
      name,
      pid: null,
      pidStartTime: null,
      pidCachedAt: null,
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
      lastResult: null,
      pendingInterruptReason: null,
      traceparent: null,
      stuckDetector: null,
      transport: resolvedTransport,
      stdioWriter: null,
      stdioReader: null,
      workCompletedSignal: completionSignal.promise,
      signalWorkCompleted: completionSignal.resolve,
    });
    return { name, transport: resolvedTransport };
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

    // A per-session binary override (--claude-binary) vouches for its own binary,
    // so it bypasses the startup spawn-disabled guard (e.g. daemon couldn't resolve
    // a default binary, but the caller is canarying a known-good one) (#2681).
    if (this.spawnDisabledReason !== null && !session.config.binaryPath) {
      throw new Error(this.spawnDisabledReason);
    }

    if (session.config.binaryPath) {
      if (this.spawnDisabledReason !== null) {
        this.logger.warn(
          `[_claude] session ${sessionId} spawned with custom binary "${session.config.binaryPath}"; bypassed spawnDisabledReason: "${this.spawnDisabledReason}"`,
        );
      } else {
        this.logger.warn(`[_claude] session ${sessionId} spawned with custom binary "${session.config.binaryPath}"`);
      }
      this.onMonitorEvent?.({
        src: "daemon.claude-server",
        event: SESSION_SPAWN_OVERRIDE,
        category: "session",
        sessionId,
        binaryPath: session.config.binaryPath,
        ...(this.spawnDisabledReason !== null ? { bypassedReason: this.spawnDisabledReason } : {}),
      });
    }

    const useStdio = session.transport === "stdio";

    // Fail-closed: the stdio transport has no can_use_tool round-trip, so
    // ContainmentGuard / input-rewriting / delegate-mode never fire (#2688).
    // Refuse a contained/worktree spawn over stdio rather than silently
    // running it outside the containment trust boundary.
    if (useStdio && session.worktree) {
      throw new Error("stdio transport does not support ContainmentGuard — use ws");
    }

    const cmd = this.buildSpawnCmd(sessionId, session, useStdio);

    const envOverrides: Record<string, string | undefined> = {};
    if (traceparent) envOverrides.TRACEPARENT = traceparent;
    if (session.config.cwd && session.config.worktree) {
      envOverrides.GIT_DIR = `${session.config.cwd}/.git`;
      envOverrides.GIT_WORK_TREE = session.config.cwd;
    }
    // TLS env only needed for WS transport (sdk-url against self-signed cert)
    if (!useStdio && this.tlsConfig) {
      envOverrides.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    // Line-buffer child stderr and forward each complete line keyed by session
    // ID (#2738). Short-lived spawn failures may emit only a partial first line,
    // so the tail is flushed on exit below — never dropped.
    const stderrState = { partial: "" };
    const emitStderr = (line: string) => {
      if (line === "") return;
      this.onStderrLine?.(sessionId, line, Date.now());
    };

    const proc = this.spawn(cmd, {
      cwd: session.config.cwd,
      stdout: useStdio ? "pipe" : "ignore",
      stderr: "pipe",
      stdin: useStdio ? "pipe" : "ignore",
      env: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
      onStderr: (chunk) => {
        const text = stderrState.partial + chunk;
        const lines = text.split("\n");
        stderrState.partial = lines.pop() ?? "";
        for (const line of lines) emitStderr(line);
        // Cap the unterminated partial: a child spewing bytes with no newline
        // (a JSON/base64 blob, a \r-only progress bar) would otherwise grow this
        // buffer — and the single line eventually forwarded across the worker
        // boundary — without bound (#2769). Force-emit in capped slices instead.
        while (stderrState.partial.length > MAX_STDERR_LINE_CHARS) {
          emitStderr(stderrState.partial.slice(0, MAX_STDERR_LINE_CHARS));
          stderrState.partial = stderrState.partial.slice(MAX_STDERR_LINE_CHARS);
        }
      },
      onStderrEnd: () => {
        // Flush the trailing partial line (stderr without a final newline) so a
        // short-lived spawn's only output is never dropped (#2738).
        const last = stderrState.partial;
        stderrState.partial = "";
        emitStderr(last);
      },
    });

    session.pid = proc.pid;
    session.pidCachedAt = Date.now();
    session.proc = proc;
    session.spawnAlive = true;

    if (useStdio) {
      session.stdioWriter = proc.stdin ?? null;
      this.startStdioReader(sessionId, session, proc);
    }

    // Connect timeout — for WS: no WS connection within deadline.
    // For stdio: no stdout line within deadline.
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.connectTimer = safeSetTimeout(() => {
      session.connectTimer = null;
      if (session.state.state !== "connecting") return;
      // For WS, also check ws presence
      if (!useStdio && session.ws !== null) return;
      this.logger.error(
        `[_claude] Connect timeout for session ${sessionId} — Claude CLI did not connect within ${this.connectTimeoutMs}ms (transport: ${session.transport})`,
      );
      if (session.proc) {
        try {
          session.proc.kill();
        } catch {
          /* already dead */
        }
      }
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

    // stderr is auto-drained by spawnManaged to prevent pipe buffer deadlock
    // (#546). Use proc.stderrTail() for diagnostics.

    // Watch for process exit
    proc.exited.then(async () => {
      if (session.proc !== proc) return;
      session.spawnAlive = false;
      if (session.state.state === "ended") return;
      if (session.proc !== proc || (session.state.state as string) === "ended") return;

      // For stdio, process exit does NOT imply stdout is drained — the trailing
      // `result` line can still sit in the pipe buffer. Wait for the reader to
      // hit EOF (which the child's stdout close delivers on exit) so that line
      // is processed before we judge completion. Otherwise we take the else
      // branch below, flip to `disconnected`, and the #2814 handleStdioLine
      // guard drops the buffered `result` — session:result never fires (#2825).
      if (session.transport === "stdio" && session.stdioDrainDone) {
        // Do NOT await the drain unbounded: a grandchild that inherited the child's
        // stdout write fd holds the pipe open past exit, so the drain's parked read()
        // never sees EOF and this handler would hang forever — no disconnect, no
        // resultWaiter rejection, no auto-terminate (#2833). Instead race the drain
        // against the work-completion signal. As soon as the buffered `result` is in
        // hand (or genuine EOF arrives) we stop waiting and cancel the reader to
        // release the parked read. This never drops a result the way a wall-clock cap
        // would (#2825): we only stop early once completion is proven.
        await Promise.race([session.stdioDrainDone, session.workCompletedSignal]);
        await this.cancelStdioReader(session);
        try {
          await session.stdioDrainDone;
        } catch {
          // drain rejections are already swallowed inside drain(); guard anyway
        }
        if (session.proc !== proc || (session.state.state as string) === "ended") return;
      }

      const stderrTail = proc.stderrTail?.() ?? "";
      const suffix = stderrTail ? `: ${stderrTail}` : "";
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
    // New turn: re-arm the completion signal so the proc.exited drain race keys off
    // THIS prompt's result, not the already-resolved prior turn's (#2833). Reset the
    // sticky workCompleted flag + lastResult for the same reason — otherwise a
    // waitForResult on the new turn would fast-path to the prior turn's stale result
    // before this turn finishes (#2858). Both are turn-scoped, like the signal.
    this.armWorkCompletedSignal(session);
    session.workCompleted = false;
    session.lastResult = null;
    const pendingReason = session.pendingInterruptReason;
    const effective = pendingReason ? `[Interrupt context: ${pendingReason}]\n\n${message}` : message;
    const outbound = session.state.queuePrompt(effective);
    session.pendingInterruptReason = null;
    if (!this.sendToSession(session, outbound)) {
      // Transport write failed — sendToSession already transitioned the session
      // to disconnected. Surface the error so the prompt isn't silently lost.
      throw new Error(`Failed to deliver prompt to session ${sessionId}: transport write failed`);
    }
    this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: effective } });
    this.recordSessionProgress(sessionId, session);
  }

  /**
   * Build the CLI command array for spawning claude.
   * WS transport: includes --sdk-url pointing at our WS server.
   * Stdio transport: no --sdk-url, no empty -p; initial prompt delivered via stdin.
   */
  private buildSpawnCmd(sessionId: string, session: WsSession, useStdio: boolean): string[] {
    // Per-session override (--claude-binary) wins over the daemon's startup-resolved
    // binary, so a single session can be pinned to a different binary (#2681).
    const cmd = [session.config.binaryPath ?? this.binaryPath];

    if (!useStdio) {
      const port = this.port;
      if (!port) throw new Error("WS server not started");
      const sdkUrl = this.tlsConfig
        ? `wss://[::1]:${port}/session/${sessionId}`
        : `ws://localhost:${port}/session/${sessionId}`;
      cmd.push("--sdk-url", sdkUrl);
      // WS transport needs an empty prompt placeholder; the real prompt
      // is delivered via the first WS message in handleOpen.
      cmd.push("-p", "");
    }

    cmd.push(
      "--permission-mode",
      "default",
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
    );

    if (useStdio) {
      // claude rejects `--print --output-format=stream-json` without --verbose
      // and exits immediately (#2688). --include-partial-messages restores the
      // stream_event liveness signal the StuckDetector consumes (absent by
      // default on the pipe transport). The WS path uses --sdk-url and needs
      // neither, so this is gated on useStdio.
      cmd.push("--verbose", "--include-partial-messages");
    }

    if (session.config.model) {
      cmd.push("--model", session.config.model);
    }
    let cliAllowedTools = session.config.allowedTools;
    if (session.config.worktree && cliAllowedTools?.length) {
      cliAllowedTools = cliAllowedTools.filter((t) => {
        const baseName = t.split("(")[0] ?? t;
        return !CONTAINMENT_WRITE_TOOLS.has(baseName);
      });
    }
    if (cliAllowedTools?.length) {
      cmd.push("--allowedTools", ...cliAllowedTools);
    }
    if (session.config.worktree && !session.config.cwd) {
      cmd.push("--worktree", session.config.worktree);
    }
    if (session.config.resumeSessionId) {
      if (session.config.resumeSessionId === "continue") {
        cmd.push("--continue");
      } else {
        cmd.push("--resume", session.config.resumeSessionId);
      }
    }
    return cmd;
  }

  /**
   * Start the stdout reader loop for a stdio-transport session.
   * Reads NDJSON lines from the process stdout and dispatches them through
   * the same handleMessage/handleSessionEvent path as the WS transport.
   * Also sends the initial user message via stdin to kick off the conversation.
   */
  private startStdioReader(sessionId: string, session: WsSession, proc: ReturnType<SpawnFn>): void {
    const stdout = proc.stdout;
    if (!stdout) {
      this.logger.error(`[_claude] stdio transport but stdout is null for session ${sessionId}`);
      return;
    }

    // Arm the completion signal for this process lifetime's first work cycle so the
    // proc.exited drain race keys off THIS run's result, not a stale prior one (#2833).
    this.armWorkCompletedSignal(session);

    // Send initial user message via stdin — this is the equivalent of
    // handleOpen's ws.send(userMessage) for WS transport.
    const prompt = session.config.prompt;
    const outbound = userMessage(prompt, sessionId);
    this.sendToSession(session, outbound);
    this.addTranscript(session, "outbound", { type: "user", message: { role: "user", content: prompt } });

    const reader = stdout.getReader();
    session.stdioReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    const drain = async () => {
      // Genuine EOF (child closed stdout) vs an external cancel (teardown /
      // proc.exited unblocking a parked read past a grandchild-held fd) both surface
      // as `done: true`. Distinguish them via the session ref: cancelStdioReader nulls
      // it before cancelling, so `stdioReader !== reader` means we were cancelled. (#2833)
      let genuineEof = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            genuineEof = session.stdioReader === reader;
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          for (let nlIdx = buffer.indexOf("\n"); nlIdx !== -1; nlIdx = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nlIdx).trim();
            buffer = buffer.slice(nlIdx + 1);
            if (!line) continue;

            // First line clears the connect timeout — equivalent of WS open
            if (session.connectTimer) {
              clearTimeout(session.connectTimer);
              session.connectTimer = null;
            }

            this.handleStdioLine(sessionId, session, line);
          }
        }
      } catch {
        // stream closed — expected on kill
      }
      // Flush remaining buffer
      const tail = decoder.decode();
      if (tail) buffer += tail;
      const remaining = buffer.trim();
      if (remaining) {
        this.handleStdioLine(sessionId, session, remaining);
      }
      // A non-EOF exit that leaves unprocessed bytes means the final line(s) were
      // truncated (reader cancelled or errored mid-stream) — log it rather than
      // treating it as a clean end, so post-mortems can tell (#2833).
      if (!genuineEof && remaining) {
        this.logger.error(
          `[_claude] stdio drain for session ${sessionId} ended without EOF (reader cancelled or errored) — ${remaining.length} trailing byte(s) may be truncated`,
        );
      }
      // Release the reader lock and drop the ref (if it still points at us) so the
      // stream can be finalized and a teardown cancel becomes a no-op.
      try {
        reader.releaseLock();
      } catch {
        // already released (e.g. by cancel()) — nothing to do
      }
      if (session.stdioReader === reader) session.stdioReader = null;
    };

    session.stdioDrainDone = drain();
  }

  /**
   * Re-arm a session's work-completion signal for a fresh work cycle. The prior
   * promise has already resolved (or is being discarded); the new one resolves on
   * the next session:result/error. Called at each spawn and each follow-up prompt so
   * the proc.exited drain race never keys off a stale earlier turn's result (#2833).
   */
  private armWorkCompletedSignal(session: WsSession): void {
    const sig = makeWorkCompletedSignal();
    session.workCompletedSignal = sig.promise;
    session.signalWorkCompleted = sig.resolve;
  }

  /**
   * Cancel the stdio stdout reader so a parked drain `read()` resolves and
   * `stdioDrainDone` can settle. A grandchild that inherited the child's stdout
   * write fd holds the pipe open past child exit, so the drain would otherwise await
   * EOF forever — stalling teardown and the proc.exited handler (#2833). Idempotent;
   * a no-op on WS sessions and once the drain has already ended.
   */
  private async cancelStdioReader(session: WsSession): Promise<void> {
    const reader = session.stdioReader;
    if (!reader) return;
    // Null first so the drain loop can tell this was an external cancel (not a
    // genuine EOF) and log any trailing truncation.
    session.stdioReader = null;
    try {
      await reader.cancel();
    } catch {
      // already closed/errored — the drain settles regardless
    }
  }

  /** Parse and dispatch a single NDJSON line from stdio stdout — mirrors handleMessage for WS. */
  private handleStdioLine(sessionId: string, session: WsSession, line: string): void {
    let messages: NdjsonMessage[];
    try {
      messages = parseFrame(line);
    } catch {
      this.logger.error(`[_claude] Failed to parse stdio NDJSON from session ${sessionId}`);
      return;
    }

    // Buffered stdout can drain in after the session is torn down: the stdio proc is
    // killed but bytes already in the pipe still reach the reader. Feeding late lines to
    // the state machine would corrupt a torn-down session, so they are dropped (#2793/#2814).
    // The teardown kind determines how far the drop goes:
    const st = session.state.state;
    if (st === "ended") {
      // VOLUNTARY teardown (bye / shutdown / terminateSession — which also removes the
      // session from the map). Nothing is dead-waiting on it, so drop everything. Honoring
      // a late `result` here would resurrect the orphaned object to "idle" (handleResult
      // unconditionally sets state=idle) and fire a spurious duplicate session:result to
      // wildcard event waiters. Neither #2830 nor #2825 reaches `ended` — both flip to
      // `disconnected` — so honoring past `ended` buys nothing and only regresses. (#2838)
      return;
    }
    if (st === "disconnected") {
      // INVOLUNTARY teardown (disconnectSession on EPIPE / spawn-exit). A `result` buffered
      // *before* the disconnect became visible is the completion signal the daemon may be
      // dead-waiting on; dropping it strands the resultWaiter forever. Two triggers hit this:
      // the proc.exited exit-vs-drain race (#2830) and an EPIPE on the initial prompt write
      // that disconnects before the reader is wired (#2825/#2838). Honor the `result` but drop
      // every non-result late line to preserve the #2793 protection, even when a frame batches
      // a result alongside stale lines.
      messages = messages.filter((m) => m.type === "result");
      if (messages.length === 0) return;
    }

    for (const msg of messages) {
      this.addTranscript(session, "inbound", msg);
      const events = session.state.handleMessage(msg);

      if (session.state.parseMismatch) {
        this.logger.error(
          `[_claude] Schema mismatch for session ${sessionId}: ${msg.type}` +
            `${msg.subtype ? `/${msg.subtype}` : ""} used fallback parsing ` +
            `(state: "${session.state.state}", keys: ${Object.keys(msg).join(", ")})`,
        );
      }

      if (msg.type === "tool_progress" || msg.type === "stream_event") {
        this.recordSessionProgress(sessionId, session);
      }

      if (events.length === 0 && !session.state.parseMismatch && !KNOWN_MSG_TYPES.has(msg.type)) {
        this.logger.error(
          `[_claude] Unrecognized message type "${msg.type}" from session ${sessionId} — ` +
            `message was silently dropped. Keys: ${Object.keys(msg).join(", ")}`,
        );
      }

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

  /** Respond to a pending permission request. */
  respondToPermission(sessionId: string, requestId: string, allow: boolean, message?: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.respondToPermission(requestId, allow, message);
    if (!this.sendToSession(session, outbound)) {
      throw new Error(`Failed to deliver permission response to session ${sessionId}: transport write failed`);
    }
    this.recordSessionProgress(sessionId, session);
  }

  /** Interrupt the current turn. If reason is provided, it is prepended to the next sendPrompt. */
  interrupt(sessionId: string, reason?: string): void {
    const session = this.getSession(sessionId);
    const outbound = session.state.interrupt();
    if (!this.sendToSession(session, outbound)) {
      throw new Error(`Failed to deliver interrupt to session ${sessionId}: transport write failed`);
    }
    session.pendingInterruptReason = reason ?? null;
  }

  /**
   * Kill a raw PID (no proc handle) with SIGTERM → SIGKILL escalation.
   * Delegates to the shared killPid utility.
   */
  private async killRawPid(pid: number, pidStartTime?: number | null, cachedAtMs?: number | null): Promise<void> {
    await killPid(pid, this.logger, {
      pidStartTime,
      killTimeoutMs: this.killTimeoutMs,
      cachedAtMs: cachedAtMs ?? undefined,
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
    session.lastResult = null;
    session.pendingInterruptReason = null;

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
    session.stdioWriter = null;

    // Kill process and wait for exit before respawning.
    // Null the ref first so the proc.exited handler (which checks session.proc !== proc)
    // skips the stale exit — we're about to respawn.
    if (session.proc) {
      const dying = session.proc;
      session.proc = null;
      session.spawnAlive = false;
      // Release any parked stdio drain before killing/respawning so the old reader
      // lock doesn't leak into the fresh spawn (#2833).
      await this.cancelStdioReader(session);
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
    if (!this.sendToSession(session, outbound)) {
      // Transport write failed — sendToSession already transitioned the session
      // to disconnected. Surface the error before mutating tracked-model state so
      // we don't emit a phantom session:model_changed for a change the child never
      // received nor report success on a dead session (#2562).
      throw new Error(`Failed to deliver set_model to session ${sessionId}: transport write failed`);
    }

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

    const info: { worktree: string | null; cwd: string | null; repoRoot: string | null } = {
      worktree: session.worktree,
      cwd: session.config.cwd ?? null,
      repoRoot: session.config.repoRoot ?? null,
    };

    // Remove from map before the guard scan so that concurrent bye() calls on sessions
    // sharing the same worktree don't see each other and both suppress — which would
    // leave the worktree orphaned. JS is single-threaded: this delete is visible to any
    // bye() that starts after the next await. terminateSession also deletes before its
    // first await (idempotent here, primary for all other call sites).
    this.sessions.delete(resolvedId);

    // Guard: suppress worktree cleanup if another session references the same worktree.
    // Parallel spawn can assign the same worktree to multiple sessions (#1836);
    // without this check, bye on a dead ghost destroys a live session's working dir (#1837).
    // Match by cwd (full path), not just worktree name — names aren't unique across repos.
    if (info.worktree) {
      for (const [otherId, other] of this.sessions) {
        if (other.worktree === info.worktree && (other.config.cwd ?? null) === info.cwd) {
          this.logger.warn(
            `[_claude] bye ${resolvedId.slice(0, 8)}: worktree "${info.worktree}" also claimed by session ${otherId.slice(0, 8)} — skipping cleanup`,
          );
          info.worktree = null;
          info.cwd = null;
          info.repoRoot = null;
          break;
        }
      }
    }

    const reason = message ? `Session ended: ${message}` : "Session ended by user";
    await this.terminateSession(resolvedId, session, reason);
    return info;
  }

  /**
   * Remove a session that was prepared but never successfully spawned.
   * Unlike terminateSession, this is synchronous and skips process/WS cleanup
   * since the session never had a process or connection (#1836).
   */
  removeUnspawnedSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
  }

  /** List all sessions. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => this.buildSessionInfo(sessionId, s));
  }

  /**
   * Check whether a session is idle (safe to send a follow-up prompt).
   * Returns the resolved session ID and current state, or null if not found
   * or the prefix is ambiguous.
   * "Idle" means state is `idle` or `init` — no active turn, no pending permissions.
   */
  checkSessionIdle(sessionId: string): { resolvedId: string; state: SessionStateEnum; idle: boolean } | null {
    let resolvedId: string;
    try {
      resolvedId = this.resolveSessionId(sessionId);
    } catch {
      return null;
    }
    const session = this.sessions.get(resolvedId);
    if (!session) return null;
    const state = session.state.state;
    return { resolvedId, state, idle: state === "idle" || state === "init" };
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

    // Fast-path: trust the sticky workCompleted flag over transient state (#2858).
    // On the stdio EPIPE trigger, failSend → disconnectSession flips state to
    // "disconnected" synchronously while the child's `result` line is still buffered;
    // handleStdioLine (#2852) then fires session:result and captures lastResult. The
    // exit handler (proc.exited) and disconnectSession already treat workCompleted as
    // the source of truth for a clean finish — waitForResult must too, or `mcx claude
    // spawn --wait` gets a rejection instead of the result the session actually produced.
    if (session.workCompleted && session.lastResult) {
      return Promise.resolve(session.lastResult);
    }

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
        timer: safeSetTimeout(() => {
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
        timer: safeSetTimeout(() => {
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
        timer: safeSetTimeout(() => {
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
        timer: safeSetTimeout(() => {
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
  private disconnectSession(sessionId: string, session: WsSession, reason: string): void {
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

    // Reject pending result waiters — they can't get results without a transport
    const waiterReason = session.transport === "stdio" ? "stdio transport disconnected" : "WebSocket disconnected";
    for (const waiter of session.resultWaiters) {
      waiter.reject(new Error(waiterReason));
    }
    session.resultWaiters.length = 0;

    // stdio has no reconnect path (unlike WS), so a disconnected stdio session
    // can never regain a channel to its child. Leaving the proc alive orphans it
    // with a dead stdin until the next daemon-start reaper. Kill it now, mirroring
    // the handleOpen WS fallback ("can't communicate without WS"). (#2793)
    if (session.transport === "stdio" && session.proc) {
      try {
        session.proc.kill();
      } catch {
        /* already dead */
      }
    }
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
        this.disconnectSession(sessionId, session, "WebSocket send failed on open");
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
    session.keepAliveTimer = safeSetInterval(() => {
      if (session.ws?.readyState === WS_OPEN) {
        try {
          session.ws.send(keepAlive());
        } catch (err) {
          this.logger.error(`[_claude] WebSocket keep-alive send failed for session ${sessionId}: ${err}`);
          this.disconnectSession(sessionId, session, "WebSocket keep-alive send failed");
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

    this.disconnectSession(sessionId, session, "WebSocket closed");
  }

  // ── Event handling ──

  private handleSessionEvent(sessionId: string, session: WsSession, event: SessionEvent): void {
    const logErr = (label: string, err: unknown) =>
      this.logger.error(
        `[_claude] ${label} for session ${sessionId}, event ${event.type}: ${err instanceof Error ? err.stack : err}`,
      );

    // For permission_request events that will be auto-resolved (non-delegate strategies),
    // suppress the monitor event and wait-notification. Only delegate strategy requires
    // orchestrator intervention; emitting for auto/rules floods the monitor stream with
    // noise that orchestrators cannot act on (fixes #2129).
    let suppressMonitorEvent = false;

    switch (event.type) {
      case "session:init":
        // Capture Claude Code's own session ID for JSONL file lookup
        session.claudeSessionId = event.sessionId;
        if (session.worktree && !session.containment && event.cwd) {
          session.containment = new ContainmentGuard(event.cwd);
        }
        this.recordSessionProgress(sessionId, session);
        break;
      case "session:response":
        this.recordSessionProgress(sessionId, session);
        this.emitToolUseEvents(sessionId, event.message);
        break;
      case "session:permission_request":
        this.recordSessionProgress(sessionId, session);
        if (session.router.strategy === "delegate") {
          session.pendingImmediate = true;
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
        } else {
          suppressMonitorEvent = true;
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
        session.signalWorkCompleted();
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
          const result: SessionResult = {
            sessionId,
            success: true,
            result: event.result,
            cost: event.cost,
            tokens: event.tokens,
            numTurns: event.numTurns,
          };
          session.lastResult = result;
          this.resolveWaiters(session, result);
        } catch (err) {
          logErr("resolveWaiters failed", err);
        }
        break;
      case "session:error":
        session.pendingImmediate = true;
        session.workCompleted = true;
        session.signalWorkCompleted();
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
          const result: SessionResult = {
            sessionId,
            success: false,
            errors: event.errors,
            cost: event.cost,
            tokens: 0,
            numTurns: 0,
          };
          session.lastResult = result;
          this.resolveWaiters(session, result);
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
        this.onMonitorEvent?.({
          src: "daemon.claude-server",
          event: WORKER_RATELIMITED,
          category: "worker",
          sessionId,
          provider: "anthropic",
          ...("retryAfterMs" in event &&
            typeof event.retryAfterMs === "number" && { retryAfterMs: event.retryAfterMs }),
        });
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

    if (!suppressMonitorEvent) {
      this.publishSessionMonitorEvent(sessionId, event);
    }
  }

  private static readonly SESSION_EVENT_MAP: Record<string, string> = {
    "session:permission_request": SESSION_PERMISSION_REQUEST,
    "session:result": SESSION_RESULT,
    "session:error": SESSION_ERROR,
    "session:cleared": SESSION_CLEARED,
    "session:model_changed": SESSION_MODEL_CHANGED,
    "session:disconnected": SESSION_DISCONNECTED,
    "session:ended": SESSION_ENDED,
    "session:containment_warning": SESSION_CONTAINMENT_WARNING,
    "session:containment_denied": SESSION_CONTAINMENT_DENIED,
    "session:containment_escalated": SESSION_CONTAINMENT_ESCALATED,
    "session:containment_reset": SESSION_CONTAINMENT_RESET,
  };

  private emitToolUseEvents(sessionId: string, msg: { message: { content: Record<string, unknown>[] } }): void {
    if (!this.onMonitorEvent) return;
    for (const block of msg.message.content) {
      if (block.type !== "tool_use" || typeof block.name !== "string") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const extracted = extractToolFields(block.name, input);
      this.onMonitorEvent({
        src: "daemon.claude-server",
        event: SESSION_TOOL_USE,
        category: "session",
        sessionId,
        toolName: block.name,
        ...extracted,
      });
    }
  }

  private publishSessionMonitorEvent(sessionId: string, event: SessionEvent): void {
    if (!this.onMonitorEvent) return;
    const mapped = ClaudeWsServer.SESSION_EVENT_MAP[event.type];
    if (!mapped) return;

    const sessionConfig = this.sessions.get(sessionId)?.config;
    const sessionRepoRoot =
      sessionConfig?.repoRoot ?? (sessionConfig?.cwd ? (findGitRoot(sessionConfig.cwd) ?? undefined) : undefined);
    const input: MonitorEventInput = {
      src: "daemon.claude-server",
      event: mapped,
      category: "session",
      sessionId,
      ...(sessionRepoRoot ? { repoRoot: sessionRepoRoot } : {}),
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
        if (
          !this.sendToSession(
            session,
            permissionDeny(requestId, result.reason, result.event === "session:containment_escalated"),
          )
        ) {
          // Write failed — sendToSession disconnected the session. Surface it via
          // the caller's .catch logger rather than swallowing the false (#2562).
          throw new Error(`Failed to deliver permission denial to session ${sessionId}: transport write failed`);
        }
        return;
      }
    }

    if (session.router.strategy === "delegate") {
      this.onMonitorEvent?.({
        src: "daemon.claude-server",
        event: SESSION_PERMISSION_BLOCKED,
        category: "session",
        sessionId,
        requestId,
        toolName: request.tool_name,
      });
      return;
    }

    const decision = await session.router.evaluate(request);
    const outbound = decision.allow
      ? permissionAllow(requestId, decision.updatedInput ?? request.input)
      : permissionDeny(requestId, decision.message ?? "Denied");

    session.state.respondToPermission(requestId, decision.allow, decision.message);
    if (!this.sendToSession(session, outbound)) {
      // Write failed — sendToSession disconnected the session. Surface it via the
      // caller's .catch logger rather than swallowing the false (#2562).
      throw new Error(`Failed to deliver permission response to session ${sessionId}: transport write failed`);
    }
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
        this.stuckClock,
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

  /**
   * Write an outbound message to the session's transport.
   *
   * Returns true if the write was issued, false if it could not be delivered.
   * On failure the session is transitioned to `disconnected` (#2562) so that a
   * dead transport cannot leave the state machine believing a prompt is being
   * processed when the child never received it. Callers that mutated session
   * state before calling (queuePrompt / respondToPermission / interrupt) MUST
   * propagate a false return rather than continue silently.
   */
  private sendToSession(session: WsSession, message: string): boolean {
    if (session.transport === "stdio") {
      if (!session.stdioWriter) {
        this.failSend(session, "stdio writer unavailable");
        return false;
      }
      try {
        session.stdioWriter.write(`${message}\n`);
        session.stdioWriter.flush();
        return true;
      } catch (err) {
        this.logger.error(`[_claude] stdio write failed: ${err}`);
        this.failSend(session, `stdio write failed: ${err}`);
        return false;
      }
    }
    // WS transport
    if (session.ws?.readyState === WS_OPEN) {
      try {
        session.ws.send(message);
        return true;
      } catch (err) {
        this.logger.error(`[_claude] WebSocket send failed: ${err}`);
        this.failSend(session, "WebSocket send failed");
        return false;
      }
    }
    this.failSend(session, "WebSocket not open");
    return false;
  }

  /** Transition a session to disconnected after a transport write failed. */
  private failSend(session: WsSession, reason: string): void {
    for (const [sid, s] of this.sessions) {
      if (s === session) {
        this.disconnectSession(sid, session, reason);
        return;
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
    session.stdioWriter = null;

    // Remove from map before any await so concurrent bye() or terminateSession()
    // calls that start after the next microtask turn won't find the session in the
    // map. JS is single-threaded: this delete is visible to any caller that begins
    // after this point. Idempotent when bye() already deleted it.
    this.sessions.delete(sessionId);

    // Kill process and await exit.
    // Null refs first so the proc.exited handler skips the stale exit
    // and no other path can signal a recycled PID.
    if (session.proc) {
      const dying = session.proc;
      session.proc = null;
      session.pid = null;
      session.pidCachedAt = null;
      session.spawnAlive = false;
      // Release a drain parked on a read() that will never EOF (grandchild holds
      // stdout fd) so it doesn't leak the reader lock (#2833). Fire-and-forget: the
      // cancel only needs to be *issued*, not awaited, before killing — awaiting it
      // would defer the synchronous proc.kill() inside killAndAwaitProc.
      void this.cancelStdioReader(session);
      await this.killAndAwaitProc(dying);
    } else if (session.pid) {
      // Restored sessions have no proc ref but may still have a live process.
      // Use killRawPid for SIGTERM → SIGKILL escalation (matches killAndAwaitProc behavior).
      // Pass pidStartTime to verify the PID hasn't been recycled by the OS.
      const pid = session.pid;
      const cachedAt = session.pidCachedAt;
      session.pid = null;
      session.pidCachedAt = null;
      await this.killRawPid(pid, session.pidStartTime, cachedAt);
    }

    // Reap detached grandchild processes (bun test workers, am-i-done runners)
    // whose cwd is under this session's worktree. These reparent to PID 1 when
    // the session process is killed and accumulate as zombies across sprints (#2493).
    // Guards: only for worktree-backed sessions, and only when no other live
    // session shares the same cwd (sprint phases reuse worktrees via --keep-worktree).
    if (session.config.cwd && session.config.worktree) {
      const cwd = session.config.cwd;
      const shared = [...this.sessions.values()].some((s) => s.config.cwd === cwd);
      if (shared) {
        this.logger.info(`[_claude] skipping reap for ${cwd} — another session still uses it`);
      } else {
        await reapWorktreeProcesses(cwd, this.logger);
      }
    }
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

// ── Helpers ──

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "EADDRINUSE";
}

// ── Tool-use field extraction (#1610) ──

const CONTENT_SCAN_LIMIT = 1_000_000;

function countNewlines(s: string): number {
  let count = 0;
  const len = Math.min(s.length, CONTENT_SCAN_LIMIT);
  for (let i = 0; i < len; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count + 1;
}

export function extractToolFields(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  switch (toolName) {
    case "Read": {
      const fp = input.file_path;
      if (typeof fp === "string") {
        fields.filePath = fp;
        fields.dirPath = dirname(fp);
      }
      fields.linesHint = typeof input.limit === "number" ? input.limit : 2000;
      break;
    }
    case "Write": {
      const fp = input.file_path;
      if (typeof fp === "string") {
        fields.filePath = fp;
        fields.dirPath = dirname(fp);
      }
      fields.linesHint = typeof input.content === "string" ? countNewlines(input.content) : 1;
      fields.isWrite = true;
      break;
    }
    case "Edit": {
      const fp = input.file_path;
      if (typeof fp === "string") {
        fields.filePath = fp;
        fields.dirPath = dirname(fp);
      }
      fields.linesHint = typeof input.new_string === "string" ? countNewlines(input.new_string) : 1;
      fields.isWrite = true;
      break;
    }
    case "Bash": {
      if (typeof input.command === "string") {
        fields.command = input.command;
        const tokens = input.command.trim().split(/\s+/);
        fields.cmdGroup = tokens.slice(0, 2).join(" ");
      }
      break;
    }
    case "Grep": {
      if (typeof input.pattern === "string") fields.pattern = input.pattern;
      if (typeof input.path === "string") fields.searchPath = input.path;
      break;
    }
    case "Glob": {
      if (typeof input.pattern === "string") fields.pattern = input.pattern;
      if (typeof input.path === "string") fields.searchPath = input.path;
      break;
    }
    case "NotebookEdit": {
      const fp = input.notebook_path ?? input.file_path;
      if (typeof fp === "string") {
        fields.filePath = fp;
        fields.dirPath = dirname(fp);
      }
      fields.isWrite = true;
      break;
    }
  }
  return fields;
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
    onStderr?: (chunk: string) => void;
    onStderrEnd?: () => void;
  },
): ReturnType<SpawnFn> {
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

  const [bin, ...args] = cmd;
  const r = spawnManaged(bin, args, {
    cwd: opts.cwd,
    env,
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "pipe",
    stdin: opts.stdin ?? "pipe",
    onStderr: opts.onStderr,
    onStderrEnd: opts.onStderrEnd,
  });
  if (!r.ok) throw new Error(`Failed to spawn ${bin}`);
  return {
    pid: r.handle.pid,
    exited: r.handle.exited.then((s) => (s.exitCode === null ? 1 : s.exitCode)),
    kill: (signal?: number) => {
      // Route signal=9 (SIGKILL) through killNow so callers running their own
      // SIGTERM-then-SIGKILL timeout (killAndAwaitProc) actually escalate. The
      // grace-based kill() is one-shot and would silently no-op the SIGKILL.
      if (signal === 9) r.handle.killNow();
      else r.handle.kill();
    },
    stderrTail: () => r.handle.stderrTail(),
    stdout: r.handle.stdout,
    stdin: r.handle.stdin ?? null,
  };
}
