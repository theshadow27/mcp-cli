/**
 * Virtual MCP server that exposes Claude Code session management tools.
 *
 * Spawns a Bun Worker running a WebSocket server + MCP Server, connects
 * a Client via WorkerClientTransport, and provides the client for
 * injection into ServerPool. Forwards DB event messages from the worker
 * to StateDb for persistence.
 *
 * Follows the same pattern as AliasServer (alias-server.ts).
 */

import type { JsonSchema, ToolInfo } from "@mcp-cli/core";
import { formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import type { StateDb } from "./db/state";
import { metrics } from "./metrics";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

export const CLAUDE_SERVER_NAME = "_claude";

/** Check if a process is still running (signal 0 = existence check). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by another user — treat as alive.
    // ESRCH means no such process — treat as dead.
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

// ── DB event messages from worker ──

interface DbUpsert {
  type: "db:upsert";
  session: {
    sessionId: string;
    pid?: number;
    state?: string;
    model?: string;
    cwd?: string;
    worktree?: string;
  };
}

interface DbState {
  type: "db:state";
  sessionId: string;
  state: string;
}

interface DbCost {
  type: "db:cost";
  sessionId: string;
  cost: number;
  tokens: number;
}

interface DbDisconnected {
  type: "db:disconnected";
  sessionId: string;
  reason: string;
}

interface DbEnd {
  type: "db:end";
  sessionId: string;
}

interface DbMetric {
  type: "metrics:inc";
  name: string;
  labels?: Record<string, string>;
  value?: number;
}

interface DbHistogram {
  type: "metrics:observe";
  name: string;
  labels?: Record<string, string>;
  value: number;
}

interface ReadyMessage {
  type: "ready";
  port: number;
}

type WorkerEvent = DbUpsert | DbState | DbCost | DbDisconnected | DbEnd | DbMetric | DbHistogram | ReadyMessage;

/** Explicit set of known worker event types — prevents ambiguous routing with MCP messages. */
const WORKER_EVENT_TYPES: ReadonlySet<string> = new Set<WorkerEvent["type"]>([
  "ready",
  "db:upsert",
  "db:state",
  "db:cost",
  "db:disconnected",
  "db:end",
  "metrics:inc",
  "metrics:observe",
]);

export function isWorkerEvent(data: unknown): data is WorkerEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    WORKER_EVENT_TYPES.has((data as { type: string }).type)
  );
}

// ── Server ──

type ClientFactory = () => Client;

export class ClaudeServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private db: StateDb;
  private wsPort: number | null = null;
  private readonly clientFactory: ClientFactory;
  private readonly activeSessions = new Set<string>();
  private readonly sessionPids = new Map<string, number>();
  /** Timestamp (ms) when each session was added to activeSessions — used to TTL pid-less zombies. */
  private readonly sessionAddedAt = new Map<string, number>();
  private restartInProgress = false;
  private stopped = false;
  private readonly crashTimestamps: number[] = [];
  /** Stored reference to the crash error handler so it can be removed via removeEventListener. */
  private crashErrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  private static readonly MAX_CRASHES = 3;
  private static readonly CRASH_WINDOW_MS = 60_000;
  /** Backoff delays (ms) for retrying start() during crash restart. */
  private static readonly RESTART_BACKOFF_MS: readonly number[] = [100, 500, 2000];
  /** Sessions without PIDs that stay disconnected longer than this are pruned as zombies. */
  private static readonly NO_PID_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

  /** Called after a successful auto-restart with the new client and transport. */
  onRestarted?: (client: Client, transport: WorkerClientTransport) => void;

  /** Called on worker activity (session events) — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    db: StateDb,
    private daemonId?: string,
    clientFactory?: ClientFactory,
  ) {
    this.db = db;
    this.clientFactory =
      clientFactory ?? (() => new Client({ name: `mcp-cli/${CLAUDE_SERVER_NAME}`, version: "0.1.0" }));
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    this.stopped = false;
    metrics.gauge("mcpd_worker_crash_loop_stopped").set(0);
    const worker = new Worker(workerPath("claude-session-worker.ts"));
    this.worker = worker;

    // Wait for the worker to report ready with its WS port
    this.wsPort = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        try {
          worker.terminate();
        } catch {
          /* worker may already be dead */
        }
        this.worker = null;
        return true;
      };
      const timeout = setTimeout(() => {
        if (cleanup()) reject(new Error("Claude session worker startup timeout"));
      }, 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve(event.data.port as number);
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`Claude session worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`Claude session worker error: ${msg}`));
      };
      // Send init to start the worker
      worker.postMessage({ type: "init", daemonId: this.daemonId });
    });

    // Set up MCP transport and connect — if anything throws, terminate the worker
    // to prevent leaked threads (#471, #453).
    try {
      this.transport = new WorkerClientTransport(this.worker);
      this.client = this.clientFactory();

      // Connect triggers MCP handshake (calls transport.start() which sets worker.onmessage).
      // Race with a timeout to prevent indefinite hangs on broken handshakes (#454).
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) => {
          handshakeTimer = setTimeout(() => reject(new Error("MCP handshake timeout (10s)")), 10_000);
        }),
      ]);
      clearTimeout(handshakeTimer);

      // After transport.start(), wrap worker.onmessage to intercept DB event messages
      const transportHandler = worker.onmessage;
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (isWorkerEvent(data)) {
          this.handleWorkerEvent(data);
          return;
        }
        // Forward MCP JSON-RPC messages to the transport
        transportHandler?.call(worker, event);
      };

      // Clear stale startup error handler before attaching crash detection
      worker.onerror = null;

      // Attach post-startup crash detection
      this.attachCrashDetection(worker);
    } catch (err) {
      // Mirror stop()'s cleanup order: close client first, then terminate worker
      try {
        await this.client?.close();
      } catch {
        // ignore close errors
      }
      try {
        worker.terminate();
      } catch {
        /* worker may already be dead */
      }
      this.worker = null;
      this.transport = null;
      this.client = null;
      this.wsPort = null;
      throw err;
    }

    return { client: this.client, transport: this.transport };
  }

  /** Stop the worker and clean up. Prevents auto-restart after crash. */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;
    this.wsPort = null;
    this.activeSessions.clear();
    this.sessionPids.clear();
    this.sessionAddedAt.clear();
    this.crashTimestamps.length = 0;
  }

  /** Get the WebSocket server port (available after start). */
  get port(): number | null {
    return this.wsPort;
  }

  /** True if any WebSocket sessions are active (not yet ended). */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  /** Remove sessions whose processes are no longer alive.
   *
   * @param now - Current timestamp in ms (injectable for testing). Defaults to Date.now().
   */
  pruneDeadSessions(now: number = Date.now()): void {
    // Prune sessions with PIDs whose process is no longer alive
    for (const [sessionId, pid] of this.sessionPids) {
      if (!isProcessAlive(pid)) {
        this.activeSessions.delete(sessionId);
        this.sessionPids.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        console.error(`[claude-server] Pruned dead session ${sessionId} (pid ${pid} no longer alive)`);
      }
    }
    // Prune sessions without PIDs that have exceeded the TTL — these are zombies
    // that can never be cleaned up by PID check (e.g., db:upsert without pid, or
    // sessions stranded after a crash when restart failed).
    for (const sessionId of this.activeSessions) {
      if (this.sessionPids.has(sessionId)) continue; // covered above
      const addedAt = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - addedAt > ClaudeServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        console.error(
          `[claude-server] Pruned pid-less zombie session ${sessionId} (exceeded ${ClaudeServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
        );
      }
    }
  }

  // ── Crash detection ──

  /** Remove event listeners and null handlers on the current worker to prevent closure leaks. */
  private cleanupWorkerHandlers(worker: Worker): void {
    if (this.crashErrorHandler) {
      worker.removeEventListener("error", this.crashErrorHandler);
      this.crashErrorHandler = null;
    }
    worker.onmessage = null;
    worker.onerror = null;
  }

  /** Attach post-startup error listener to detect worker crashes. */
  private attachCrashDetection(worker: Worker): void {
    const handler = (event: ErrorEvent | Event) => {
      // Only handle if this is still our active worker
      if (this.worker !== worker) return;
      const msg = event instanceof ErrorEvent ? event.message : "unknown error";
      this.handleWorkerCrash(`worker error: ${msg}`);
    };
    this.crashErrorHandler = handler;
    worker.addEventListener("error", handler);
  }

  /** Handle a worker crash: end orphaned sessions and attempt auto-restart. */
  private async handleWorkerCrash(reason: string): Promise<void> {
    metrics.counter("mcpd_worker_crashes_total").inc();
    if (this.restartInProgress || this.stopped) return;
    this.restartInProgress = true;

    console.error(`[claude-server] Worker crash detected: ${reason}`);

    // Mark tracked sessions as disconnected in SQLite — NOT ended.
    // The Claude processes may still be running; keep them in activeSessions
    // so the idle timeout won't fire while they exist.
    for (const sessionId of this.activeSessions) {
      console.error(`[claude-server] Session ${sessionId} disconnected (worker crash)`);
      this.db.updateSessionState(sessionId, "disconnected");
    }

    // Snapshot pre-crash session IDs — after restart they can no longer reconnect
    // to the new WS server (new port, new worker instance).
    const orphanedSessions = new Set(this.activeSessions);

    // Clean up event handlers on the dead worker to release closure references
    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
    }
    this.worker = null;
    this.transport = null;
    this.client = null;
    this.wsPort = null;

    // Rate-limit restarts to prevent crash loops
    const now = Date.now();
    this.crashTimestamps.push(now);
    // Trim timestamps outside the window
    while (this.crashTimestamps.length > 0 && (this.crashTimestamps[0] ?? 0) <= now - ClaudeServer.CRASH_WINDOW_MS) {
      this.crashTimestamps.shift();
    }
    if (this.crashTimestamps.length > ClaudeServer.MAX_CRASHES) {
      console.error(
        `[claude-server] ${this.crashTimestamps.length} crashes in ${ClaudeServer.CRASH_WINDOW_MS / 1000}s — giving up auto-restart`,
      );
      this.stopped = true;
      this.restartInProgress = false;
      metrics.gauge("mcpd_worker_crash_loop_stopped").set(1);
      return;
    }

    // Auto-restart with backoff retries
    const backoffs = ClaudeServer.RESTART_BACKOFF_MS;
    let lastErr: unknown;

    try {
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        if (attempt > 0) {
          const delay = backoffs[attempt - 1] ?? backoffs.at(-1) ?? 2000;
          console.error(`[claude-server] Retry ${attempt}/${backoffs.length} after ${delay}ms...`);
          await Bun.sleep(delay);
        }

        // Respect stop() called during backoff sleep
        if (this.stopped) {
          console.error("[claude-server] Server stopped during restart backoff — aborting");
          return;
        }

        try {
          console.error("[claude-server] Restarting worker...");
          const { client, transport } = await this.start();
          console.error(`[claude-server] Worker restarted successfully (port ${this.wsPort})`);

          // End sessions orphaned by the old worker — they can no longer reconnect
          // to the new WS server (new port). Skip any already ended via db:end.
          for (const sessionId of orphanedSessions) {
            if (!this.activeSessions.has(sessionId)) continue;
            console.error(`[claude-server] Ending orphaned session ${sessionId} (old worker, new WS port)`);
            this.activeSessions.delete(sessionId);
            this.sessionPids.delete(sessionId);
            this.sessionAddedAt.delete(sessionId);
            this.db.endSession(sessionId);
          }
          metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);

          // Notify connected MCP clients that the tool list may have changed
          // (this.worker is set by start() but TS can't track cross-method mutation)
          (this.worker as Worker | null)?.postMessage({ type: "tools_changed" });
          this.onRestarted?.(client, transport);
          return;
        } catch (err) {
          lastErr = err;
          console.error(`[claude-server] Restart attempt ${attempt + 1} failed: ${err}`);
        }
      }

      // All retries exhausted
      console.error(
        `[claude-server] All ${backoffs.length + 1} restart attempts failed (last: ${lastErr}) — giving up`,
      );
      this.stopped = true;
    } finally {
      this.restartInProgress = false;
    }
  }

  // ── DB event handling ──

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "ready":
        // Already handled during start(), ignore subsequent
        break;
      case "db:upsert":
        this.activeSessions.add(event.session.sessionId);
        if (event.session.pid != null) {
          this.sessionPids.set(event.session.sessionId, event.session.pid);
        }
        this.sessionAddedAt.set(event.session.sessionId, Date.now());
        this.db.upsertSession(event.session);
        metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        metrics.counter("mcpd_sessions_total").inc();
        this.onActivity?.();
        break;
      case "db:state":
        this.db.updateSessionState(event.sessionId, event.state);
        this.onActivity?.();
        break;
      case "db:cost":
        this.db.updateSessionCost(event.sessionId, event.cost, event.tokens);
        metrics.counter("mcpd_session_cost_usd").inc(event.cost);
        this.onActivity?.();
        break;
      case "db:disconnected":
        // Session lost transport but was NOT bye'd — keep in activeSessions
        console.error(`[claude-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
        this.sessionPids.delete(event.sessionId);
        this.sessionAddedAt.delete(event.sessionId);
        this.db.endSession(event.sessionId);
        metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        break;
      case "metrics:inc":
        metrics.counter(event.name, event.labels).inc(event.value ?? 1);
        break;
      case "metrics:observe":
        metrics.histogram(event.name, event.labels).observe(event.value);
        break;
    }
  }
}

/** Build static ToolInfo for pre-populating the pool's tool cache. */
export function buildClaudeToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();

  for (const def of CLAUDE_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: CLAUDE_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }

  return tools;
}
