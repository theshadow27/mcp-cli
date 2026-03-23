/**
 * Virtual MCP server that exposes OpenCode agent session management tools.
 *
 * Spawns a Bun Worker running an MCP Server that manages OpenCodeSession
 * instances. Connects a Client via WorkerClientTransport and provides
 * the client for injection into ServerPool.
 *
 * Mirrors acp-server.ts but for the OpenCode HTTP+SSE protocol.
 */

import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { OPENCODE_SERVER_NAME, consoleLogger, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { closeClientWithTimeout } from "./close-timeout";
import type { StateDb } from "./db/state";
import { type MetricsCollector, metrics as defaultMetrics } from "./metrics";
import { OPENCODE_TOOLS } from "./opencode-session/tools";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

// ── DB event messages from worker (same protocol as acp-server) ──

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

export function isOpenCodeWorkerEvent(data: unknown): data is WorkerEvent {
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

export class OpenCodeServer {
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

  /** Called on worker activity — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    db: StateDb,
    private daemonId?: string,
    clientFactory?: ClientFactory,
    logger?: Logger,
    private handshakeTimeoutMs = 10_000,
    workerFactory?: WorkerFactory,
    metricsCollector?: MetricsCollector,
  ) {
    this.db = db;
    this.clientFactory =
      clientFactory ?? (() => new Client({ name: `mcp-cli/${OPENCODE_SERVER_NAME}`, version: "0.1.0" }));
    this.workerFactory = workerFactory ?? ((path) => new Worker(path));
    this.logger = logger ?? consoleLogger;
    this.metrics = metricsCollector ?? defaultMetrics;
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    if (this.worker) throw new Error("start() called while worker is already running");
    this.stopped = false;
    this.metrics.gauge("mcpd_opencode_worker_crash_loop_stopped").set(0);
    const worker = this.workerFactory(workerPath("opencode-session-worker.ts"));
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
        if (cleanup()) reject(new Error("OpenCode session worker startup timeout"));
      }, 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`OpenCode session worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`OpenCode session worker error: ${msg}`));
      };
      worker.postMessage({ type: "init", daemonId: this.daemonId });
    });

    // Set up MCP transport and connect
    try {
      this.transport = new WorkerClientTransport(this.worker);
      this.client = this.clientFactory();

      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) => {
          handshakeTimer = setTimeout(() => {
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
        if (isOpenCodeWorkerEvent(data)) {
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

  /** True if any OpenCode sessions are active (not yet ended). */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  /** Remove sessions that have exceeded the TTL without activity. */
  pruneDeadSessions(now: number = Date.now()): void {
    for (const sessionId of this.activeSessions) {
      const lastSeen = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - lastSeen > OpenCodeServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        this.metrics.gauge("mcpd_opencode_active_sessions").set(this.activeSessions.size);
        this.logger.warn(
          `[opencode-server] Pruned stale session ${sessionId} (exceeded ${OpenCodeServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
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
    this.metrics.counter("mcpd_opencode_worker_crashes_total").inc();
    if (this.stopped) return;
    if (this.restartInProgress) {
      this.pendingCrashReason = reason;
      return;
    }
    this.restartInProgress = true;

    this.logger.error(`[opencode-server] Worker crash detected: ${reason}`);

    for (const sessionId of this.activeSessions) {
      this.logger.warn(`[opencode-server] Session ${sessionId} disconnected (worker crash)`);
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
    while (this.crashTimestamps.length > 0 && (this.crashTimestamps[0] ?? 0) <= now - OpenCodeServer.CRASH_WINDOW_MS) {
      this.crashTimestamps.shift();
    }
    if (this.crashTimestamps.length > OpenCodeServer.MAX_CRASHES) {
      this.logger.error(
        `[opencode-server] ${this.crashTimestamps.length} crashes in ${OpenCodeServer.CRASH_WINDOW_MS / 1000}s — giving up auto-restart`,
      );
      this.stopped = true;
      this.restartInProgress = false;
      for (const sessionId of this.activeSessions) {
        this.db.endSession(sessionId);
      }
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.metrics.gauge("mcpd_opencode_active_sessions").set(0);
      this.metrics.gauge("mcpd_opencode_worker_crash_loop_stopped").set(1);
      return;
    }

    // Auto-restart with backoff
    const backoffs = OpenCodeServer.RESTART_BACKOFF_MS;
    let lastErr: unknown;

    try {
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        if (attempt > 0) {
          const delay = backoffs[attempt - 1] ?? backoffs.at(-1) ?? 2000;
          this.logger.warn(`[opencode-server] Retry ${attempt}/${backoffs.length} after ${delay}ms...`);
          await Bun.sleep(delay);
        }

        if (this.stopped) {
          this.logger.info("[opencode-server] Server stopped during restart backoff — aborting");
          return;
        }

        try {
          this.logger.info("[opencode-server] Restarting worker...");
          const { client, transport } = await this.start();
          this.logger.info("[opencode-server] Worker restarted successfully");

          for (const sessionId of orphanedSessions) {
            if (!this.activeSessions.has(sessionId)) continue;
            this.logger.warn(`[opencode-server] Ending orphaned session ${sessionId}`);
            this.activeSessions.delete(sessionId);
            this.sessionAddedAt.delete(sessionId);
            this.db.endSession(sessionId);
          }
          this.metrics.gauge("mcpd_opencode_active_sessions").set(this.activeSessions.size);

          (this.worker as Worker | null)?.postMessage({ type: "tools_changed" });
          this.onRestarted?.(client, transport);
          return;
        } catch (err) {
          lastErr = err;
          this.logger.error(`[opencode-server] Restart attempt ${attempt + 1} failed: ${err}`);
        }
      }

      this.logger.error(
        `[opencode-server] All ${backoffs.length + 1} restart attempts failed (last: ${lastErr}) — giving up`,
      );
      this.stopped = true;
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.metrics.gauge("mcpd_opencode_active_sessions").set(0);
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
        this.metrics.gauge("mcpd_opencode_active_sessions").set(this.activeSessions.size);
        this.metrics.counter("mcpd_opencode_sessions_total").inc();
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
        this.logger.warn(`[opencode-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
        this.sessionAddedAt.delete(event.sessionId);
        this.db.endSession(event.sessionId);
        this.metrics.gauge("mcpd_opencode_active_sessions").set(this.activeSessions.size);
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
export function buildOpenCodeToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();

  for (const def of OPENCODE_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: OPENCODE_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }

  return tools;
}
