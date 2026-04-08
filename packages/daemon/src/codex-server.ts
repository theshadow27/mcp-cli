/**
 * Virtual MCP server that exposes Codex session management tools.
 *
 * Spawns a Bun Worker running an MCP Server that manages CodexSession
 * instances. Connects a Client via WorkerClientTransport and provides
 * the client for injection into ServerPool. Forwards DB event messages
 * from the worker to StateDb for persistence.
 *
 * Mirrors the ClaudeServer pattern (claude-server.ts) but is simpler:
 * no WebSocket server — Codex sessions are managed directly in the worker.
 */

import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { CODEX_SERVER_NAME, consoleLogger, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { closeClientWithTimeout } from "./close-timeout";
import { CODEX_TOOLS } from "./codex-session/tools";
import type { StateDb } from "./db/state";
import { type MetricsCollector, metrics as defaultMetrics } from "./metrics";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

// ── DB event messages from worker (same protocol as claude-server) ──

interface DbUpsert {
  type: "db:upsert";
  session: {
    sessionId: string;
    pid?: number;
    state?: string;
    model?: string;
    cwd?: string;
    worktree?: string;
    repoRoot?: string;
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
type WorkerFactory = (scriptPath: string) => Worker;

export class CodexServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private db: StateDb;
  private readonly clientFactory: ClientFactory;
  private readonly workerFactory: WorkerFactory;
  private readonly activeSessions = new Set<string>();
  private readonly sessionAddedAt = new Map<string, number>();
  private restartInProgress = false;
  private pendingCrashReason: string | null = null;
  private stopped = false;
  private readonly crashTimestamps: number[] = [];
  private crashErrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private static readonly MAX_CRASHES = 3;
  private static readonly CRASH_WINDOW_MS = 60_000;
  private static readonly RESTART_BACKOFF_MS: readonly number[] = [100, 500, 2000];
  private static readonly NO_PID_SESSION_TTL_MS = 10 * 60 * 1000;

  /** Called after a successful auto-restart with the new client and transport. */
  onRestarted?: (client: Client, transport: WorkerClientTransport) => void;

  /** Called on worker activity (session events) — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    db: StateDb,
    private daemonId?: string,
    clientFactory?: ClientFactory,
    logger?: Logger,
    private handshakeTimeoutMs = 10_000,
    metricsCollector?: MetricsCollector,
    workerFactory?: WorkerFactory,
  ) {
    this.db = db;
    this.clientFactory =
      clientFactory ?? (() => new Client({ name: `mcp-cli/${CODEX_SERVER_NAME}`, version: "0.1.0" }));
    this.logger = logger ?? consoleLogger;
    this.metrics = metricsCollector ?? defaultMetrics;
    this.workerFactory = workerFactory ?? ((path) => new Worker(path));
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    if (this.worker) throw new Error("start() called while worker is already running");
    this.stopped = false;
    this.metrics.gauge("mcpd_codex_worker_crash_loop_stopped").set(0);
    const worker = this.workerFactory(workerPath("codex-session-worker.ts"));
    this.worker = worker;

    // Wait for the worker to report ready
    await new Promise<void>((resolve, reject) => {
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
        if (cleanup()) reject(new Error("Codex session worker startup timeout"));
      }, 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`Codex session worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`Codex session worker error: ${msg}`));
      };
      worker.postMessage({ type: "init", daemonId: this.daemonId });
    });

    // Set up MCP transport and connect
    try {
      this.transport = new WorkerClientTransport(this.worker);
      this.client = this.clientFactory();

      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let connectResolved = false;
      await Promise.race([
        this.client.connect(this.transport).then((r) => {
          connectResolved = true;
          return r;
        }),
        new Promise<never>((_, reject) => {
          handshakeTimer = setTimeout(() => {
            if (connectResolved) return;
            this.metrics.counter("mcpd_connect_timeouts_total").inc();
            reject(new Error("MCP handshake timeout (10s)"));
          }, this.handshakeTimeoutMs);
        }),
      ]);
      clearTimeout(handshakeTimer);

      // Wrap worker.onmessage to intercept DB event messages
      const transportHandler = worker.onmessage;
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (isWorkerEvent(data)) {
          this.handleWorkerEvent(data);
          return;
        }
        transportHandler?.call(worker, event);
      };

      worker.onerror = null;
      this.attachCrashDetection(worker);
    } catch (err) {
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
      throw err;
    }

    return { client: this.client, transport: this.transport };
  }

  /** Stop the worker and clean up. Prevents auto-restart after crash. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.onRestarted = undefined;
    await closeClientWithTimeout(this.client);
    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;
    for (const sessionId of this.activeSessions) {
      try {
        this.db.endSession(sessionId);
      } catch {
        // ignore DB errors during stop
      }
    }
    this.activeSessions.clear();
    this.sessionAddedAt.clear();
    this.crashTimestamps.length = 0;
  }

  /** True if any Codex sessions are active (not yet ended). */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  /** Remove sessions that have exceeded the TTL without activity.
   *  sessionAddedAt is refreshed on db:state/db:cost events, so it acts as
   *  "last seen" — only truly idle sessions get pruned. */
  pruneDeadSessions(now: number = Date.now()): void {
    for (const sessionId of this.activeSessions) {
      const lastSeen = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - lastSeen > CodexServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        this.metrics.gauge("mcpd_codex_active_sessions").set(this.activeSessions.size);
        this.logger.warn(
          `[codex-server] Pruned stale session ${sessionId} (exceeded ${CodexServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
        );
      }
    }
  }

  // ── Crash detection ──

  private cleanupWorkerHandlers(worker: Worker): void {
    if (this.crashErrorHandler) {
      worker.removeEventListener("error", this.crashErrorHandler);
      this.crashErrorHandler = null;
    }
    worker.onmessage = null;
    worker.onerror = null;
  }

  private attachCrashDetection(worker: Worker): void {
    const handler = (event: ErrorEvent | Event) => {
      if (this.worker !== worker) return;
      const msg = event instanceof ErrorEvent ? event.message : "unknown error";
      this.handleWorkerCrash(`worker error: ${msg}`);
    };
    this.crashErrorHandler = handler;
    worker.addEventListener("error", handler);
  }

  private async handleWorkerCrash(reason: string): Promise<void> {
    this.metrics.counter("mcpd_codex_worker_crashes_total").inc();
    if (this.stopped) return;
    if (this.restartInProgress) {
      this.pendingCrashReason = reason;
      return;
    }
    this.restartInProgress = true;

    this.logger.error(`[codex-server] Worker crash detected: ${reason}`);

    for (const sessionId of this.activeSessions) {
      this.logger.warn(`[codex-server] Session ${sessionId} disconnected (worker crash)`);
      this.db.updateSessionState(sessionId, "disconnected");
    }

    const orphanedSessions = new Set(this.activeSessions);

    await closeClientWithTimeout(this.client);

    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;

    // Rate-limit restarts
    const now = Date.now();
    this.crashTimestamps.push(now);
    while (this.crashTimestamps.length > 0 && (this.crashTimestamps[0] ?? 0) <= now - CodexServer.CRASH_WINDOW_MS) {
      this.crashTimestamps.shift();
    }
    if (this.crashTimestamps.length > CodexServer.MAX_CRASHES) {
      this.logger.error(
        `[codex-server] ${this.crashTimestamps.length} crashes in ${CodexServer.CRASH_WINDOW_MS / 1000}s — giving up auto-restart`,
      );
      this.stopped = true;
      this.restartInProgress = false;
      for (const sessionId of this.activeSessions) {
        this.db.endSession(sessionId);
      }
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.metrics.gauge("mcpd_codex_active_sessions").set(0);
      this.metrics.gauge("mcpd_codex_worker_crash_loop_stopped").set(1);
      return;
    }

    // Auto-restart with backoff
    const backoffs = CodexServer.RESTART_BACKOFF_MS;
    let lastErr: unknown;

    try {
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        if (attempt > 0) {
          const delay = backoffs[attempt - 1] ?? backoffs.at(-1) ?? 2000;
          this.logger.warn(`[codex-server] Retry ${attempt}/${backoffs.length} after ${delay}ms...`);
          await Bun.sleep(delay);
        }

        if (this.stopped) {
          this.logger.info("[codex-server] Server stopped during restart backoff — aborting");
          return;
        }

        try {
          this.logger.info("[codex-server] Restarting worker...");
          const { client, transport } = await this.start();
          this.logger.info("[codex-server] Worker restarted successfully");

          // End orphaned sessions
          for (const sessionId of orphanedSessions) {
            if (!this.activeSessions.has(sessionId)) continue;
            this.logger.warn(`[codex-server] Ending orphaned session ${sessionId}`);
            this.activeSessions.delete(sessionId);
            this.sessionAddedAt.delete(sessionId);
            this.db.endSession(sessionId);
          }
          this.metrics.gauge("mcpd_codex_active_sessions").set(this.activeSessions.size);

          (this.worker as Worker | null)?.postMessage({ type: "tools_changed" });
          this.onRestarted?.(client, transport);
          return;
        } catch (err) {
          lastErr = err;
          this.logger.error(`[codex-server] Restart attempt ${attempt + 1} failed: ${err}`);
        }
      }

      this.logger.error(
        `[codex-server] All ${backoffs.length + 1} restart attempts failed (last: ${lastErr}) — giving up`,
      );
      this.stopped = true;
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.metrics.gauge("mcpd_codex_active_sessions").set(0);
    } finally {
      this.restartInProgress = false;
      if (this.pendingCrashReason !== null && !this.stopped) {
        const pending = this.pendingCrashReason;
        this.pendingCrashReason = null;
        await this.handleWorkerCrash(pending);
      }
    }
  }

  // ── DB event handling ──

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "ready":
        break;
      case "db:upsert":
        this.activeSessions.add(event.session.sessionId);
        this.sessionAddedAt.set(event.session.sessionId, Date.now());
        this.db.upsertSession(event.session);
        this.metrics.gauge("mcpd_codex_active_sessions").set(this.activeSessions.size);
        this.metrics.counter("mcpd_codex_sessions_total").inc();
        this.onActivity?.();
        break;
      case "db:state":
        this.sessionAddedAt.set(event.sessionId, Date.now());
        this.db.updateSessionState(event.sessionId, event.state);
        this.onActivity?.();
        break;
      case "db:cost":
        this.sessionAddedAt.set(event.sessionId, Date.now());
        this.db.updateSessionCost(event.sessionId, event.cost, event.tokens);
        this.onActivity?.();
        break;
      case "db:disconnected":
        this.logger.warn(`[codex-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
        this.sessionAddedAt.delete(event.sessionId);
        this.db.endSession(event.sessionId);
        this.metrics.gauge("mcpd_codex_active_sessions").set(this.activeSessions.size);
        break;
      case "metrics:inc":
        this.metrics.counter(event.name, event.labels).inc(event.value ?? 1);
        break;
      case "metrics:observe":
        this.metrics.histogram(event.name, event.labels).observe(event.value);
        break;
    }
  }
}

/** Build static ToolInfo for pre-populating the pool's tool cache. */
export function buildCodexToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();

  for (const def of CODEX_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: CODEX_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }

  return tools;
}
