import type { Logger } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { closeClientWithTimeout } from "./close-timeout";
import type { StateDb } from "./db/state";
import { type MetricsCollector, metrics as defaultMetrics } from "./metrics";
import {
  DEFAULT_RESTART_POLICY,
  type RestartPolicy,
  getBackoffDelay,
  maxAttempts,
  shouldRestart,
} from "./restart-policy";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

// ── Shared DB event types (previously duplicated across all four servers) ──

export interface DbUpsertSession {
  sessionId: string;
  name?: string;
  pid?: number;
  pidStartTime?: number | null;
  state?: string;
  model?: string;
  cwd?: string;
  worktree?: string;
  repoRoot?: string;
}

interface DbUpsert {
  type: "db:upsert";
  session: DbUpsertSession;
}

interface DbState {
  type: "db:state";
  sessionId: string;
  state: string;
}

export interface DbCost {
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
  [key: string]: unknown;
}

export type BaseWorkerEvent =
  | DbUpsert
  | DbState
  | DbCost
  | DbDisconnected
  | DbEnd
  | DbMetric
  | DbHistogram
  | ReadyMessage;

export const BASE_WORKER_EVENT_TYPES: ReadonlySet<string> = new Set<BaseWorkerEvent["type"]>([
  "ready",
  "db:upsert",
  "db:state",
  "db:cost",
  "db:disconnected",
  "db:end",
  "metrics:inc",
  "metrics:observe",
]);

export function isBaseWorkerEvent(data: unknown): data is BaseWorkerEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    BASE_WORKER_EVENT_TYPES.has((data as { type: string }).type)
  );
}

// ── Descriptor ──

export interface WorkerServerDescriptor {
  providerName: string;
  displayName: string;
  serverName: string;
  workerScript: string;
  metrics: {
    crashLoopStopped: string;
    crashesTotal: string;
    activeSessions: string;
    sessionsTotal: string;
  };
}

// ── Base class ──

export abstract class AbstractWorkerServer {
  protected worker: Worker | null = null;
  protected transport: WorkerClientTransport | null = null;
  protected client: Client | null = null;
  protected readonly db: StateDb;
  protected readonly daemonId?: string;
  protected readonly clientFactory: () => Client;
  protected readonly workerFactory: (scriptPath: string) => Worker;
  protected readonly activeSessions = new Set<string>();
  protected readonly sessionAddedAt = new Map<string, number>();
  protected restartInProgress = false;
  protected pendingCrashReason: string | null = null;
  protected stopped = false;
  protected readonly crashTimestamps: number[] = [];
  protected crashErrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  protected readonly logger: Logger;
  protected readonly metrics: MetricsCollector;
  protected readonly restartPolicy: RestartPolicy = DEFAULT_RESTART_POLICY;
  protected readonly handshakeTimeoutMs: number;
  protected static readonly NO_PID_SESSION_TTL_MS = 10 * 60 * 1000;

  onRestarted?: (client: Client, transport: WorkerClientTransport) => void;
  onActivity?: () => void;

  abstract get descriptor(): WorkerServerDescriptor;

  constructor(
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: Logger,
    handshakeTimeoutMs = 10_000,
    metricsCollector?: MetricsCollector,
    workerFactory?: (scriptPath: string) => Worker,
  ) {
    this.db = db;
    this.daemonId = daemonId;
    this.clientFactory =
      clientFactory ?? (() => new Client({ name: `mcp-cli/${this.descriptor.serverName}`, version: "0.1.0" }));
    this.logger = logger ?? consoleLogger;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.metrics = metricsCollector ?? defaultMetrics;
    this.workerFactory = workerFactory ?? ((path) => new Worker(path));
  }

  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    if (this.worker) throw new Error("start() called while worker is already running");
    this.stopped = false;
    const d = this.descriptor;
    this.metrics.gauge(d.metrics.crashLoopStopped).set(0);
    const worker = this.workerFactory(workerPath(d.workerScript));
    this.worker = worker;

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
        if (cleanup()) reject(new Error(`${d.displayName} session worker startup timeout`));
      }, 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          this.onWorkerReady(event.data);
          resolve();
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`${d.displayName} session worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`${d.displayName} session worker error: ${msg}`));
      };
      worker.postMessage(this.buildInitMessage());
    });

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
            reject(new Error(`MCP handshake timeout (${this.handshakeTimeoutMs / 1000}s)`));
          }, this.handshakeTimeoutMs);
        }),
      ]);
      clearTimeout(handshakeTimer);

      const transportHandler = worker.onmessage;
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (isBaseWorkerEvent(data)) {
          this.handleWorkerEvent(data);
          return;
        }
        if (this.isProviderEvent(data)) {
          this.handleProviderEvent(data);
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
      this.teardownWorkerExtra();
      throw err;
    }

    try {
      this.onPostStart();
    } catch (err) {
      try {
        await this.client?.close();
      } catch {
        // ignore close errors
      }
      this.cleanupWorkerHandlers(worker);
      try {
        worker.terminate();
      } catch {
        /* worker may already be dead */
      }
      this.worker = null;
      this.transport = null;
      this.client = null;
      this.teardownWorkerExtra();
      throw err;
    }
    return { client: this.client, transport: this.transport };
  }

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
    this.extraStopCleanup();
    this.crashTimestamps.length = 0;
  }

  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  pruneDeadSessions(now: number = Date.now()): void {
    const d = this.descriptor;
    for (const sessionId of this.activeSessions) {
      const lastSeen = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - lastSeen > AbstractWorkerServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        this.metrics.gauge(d.metrics.activeSessions).set(this.activeSessions.size);
        this.logger.warn(
          `[${d.providerName}-server] Pruned stale session ${sessionId} (exceeded ${AbstractWorkerServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
        );
      }
    }
  }

  // ── Protected hooks (override in subclasses) ──

  protected buildInitMessage(): Record<string, unknown> {
    return { type: "init", daemonId: this.daemonId };
  }

  protected onWorkerReady(_data: unknown): void {}
  protected onPostStart(): void {}
  protected extraStopCleanup(): void {}
  protected teardownWorkerExtra(): void {}
  protected onCrashDetected(): void {}
  protected isProviderEvent(_data: unknown): boolean {
    return false;
  }
  protected handleProviderEvent(_event: unknown): void {}

  protected processSessionUpsert(session: DbUpsertSession): DbUpsertSession {
    return session;
  }
  protected onSessionCost(_event: DbCost): void {}
  protected onSessionEnd(_sessionId: string): void {}

  protected captureOrphanedSessions(): Set<string> | null {
    return new Set(this.activeSessions);
  }
  protected preCrashClearState(): void {}
  protected onOrphanSessionEnd(_sessionId: string): void {}
  protected crashGiveUpExtraCleanup(): void {}

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
    const d = this.descriptor;
    this.metrics.counter(d.metrics.crashesTotal).inc();
    this.onCrashDetected();
    if (this.stopped) return;
    if (this.restartInProgress) {
      this.pendingCrashReason = reason;
      return;
    }
    this.restartInProgress = true;

    this.logger.error(`[${d.providerName}-server] Worker crash detected: ${reason}`);

    for (const sessionId of this.activeSessions) {
      this.logger.warn(`[${d.providerName}-server] Session ${sessionId} disconnected (worker crash)`);
      this.db.updateSessionState(sessionId, "disconnected");
    }

    const orphanedSessions = this.captureOrphanedSessions();
    this.preCrashClearState();

    await closeClientWithTimeout(this.client);

    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;
    this.teardownWorkerExtra();

    if (!shouldRestart(this.crashTimestamps, this.restartPolicy)) {
      this.logger.error(
        `[${d.providerName}-server] ${this.crashTimestamps.length} crashes in ${this.restartPolicy.crashWindowMs / 1000}s — giving up auto-restart`,
      );
      this.stopped = true;
      this.restartInProgress = false;
      for (const sessionId of this.activeSessions) {
        this.db.endSession(sessionId);
      }
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.crashGiveUpExtraCleanup();
      this.metrics.gauge(d.metrics.activeSessions).set(0);
      this.metrics.gauge(d.metrics.crashLoopStopped).set(1);
      return;
    }

    const totalAttempts = maxAttempts(this.restartPolicy);
    let lastErr: unknown;

    try {
      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        if (attempt > 0) {
          const delay = getBackoffDelay(attempt, this.restartPolicy.backoffDelaysMs);
          this.logger.warn(`[${d.providerName}-server] Retry ${attempt}/${totalAttempts - 1} after ${delay}ms...`);
          await Bun.sleep(delay);
        }

        if (this.stopped) {
          this.logger.info(`[${d.providerName}-server] Server stopped during restart backoff — aborting`);
          return;
        }

        try {
          this.logger.info(`[${d.providerName}-server] Restarting worker...`);
          const { client, transport } = await this.start();
          this.logger.info(`[${d.providerName}-server] Worker restarted successfully`);

          if (orphanedSessions) {
            for (const sessionId of orphanedSessions) {
              if (!this.activeSessions.has(sessionId)) continue;
              this.logger.warn(`[${d.providerName}-server] Ending orphaned session ${sessionId}`);
              this.activeSessions.delete(sessionId);
              this.sessionAddedAt.delete(sessionId);
              this.onOrphanSessionEnd(sessionId);
              this.db.endSession(sessionId);
            }
          }
          this.metrics.gauge(d.metrics.activeSessions).set(this.activeSessions.size);

          (this.worker as Worker | null)?.postMessage({ type: "tools_changed" });
          this.onRestarted?.(client, transport);
          return;
        } catch (err) {
          lastErr = err;
          this.logger.error(`[${d.providerName}-server] Restart attempt ${attempt + 1} failed: ${err}`);
        }
      }

      this.logger.error(
        `[${d.providerName}-server] All ${totalAttempts} restart attempts failed (last: ${lastErr}) — giving up`,
      );
      this.stopped = true;
      this.activeSessions.clear();
      this.sessionAddedAt.clear();
      this.crashGiveUpExtraCleanup();
      this.metrics.gauge(d.metrics.activeSessions).set(0);
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

  private handleWorkerEvent(event: BaseWorkerEvent): void {
    const d = this.descriptor;
    switch (event.type) {
      case "ready":
        break;
      case "db:upsert": {
        this.activeSessions.add(event.session.sessionId);
        this.sessionAddedAt.set(event.session.sessionId, Date.now());
        const processed = this.processSessionUpsert(event.session);
        const { pidStartTime: pst, ...sessionRest } = processed;
        const upsertData: typeof sessionRest & { pidStartTime?: number } = { ...sessionRest };
        if (pst != null) upsertData.pidStartTime = pst;
        this.db.upsertSession(upsertData);
        this.metrics.gauge(d.metrics.activeSessions).set(this.activeSessions.size);
        this.metrics.counter(d.metrics.sessionsTotal).inc();
        this.onActivity?.();
        break;
      }
      case "db:state":
        this.sessionAddedAt.set(event.sessionId, Date.now());
        this.db.updateSessionState(event.sessionId, event.state);
        this.onActivity?.();
        break;
      case "db:cost":
        this.sessionAddedAt.set(event.sessionId, Date.now());
        this.db.updateSessionCost(event.sessionId, event.cost, event.tokens);
        this.onSessionCost(event);
        this.onActivity?.();
        break;
      case "db:disconnected":
        this.logger.warn(`[${d.providerName}-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
        this.sessionAddedAt.delete(event.sessionId);
        this.onSessionEnd(event.sessionId);
        this.db.endSession(event.sessionId);
        this.metrics.gauge(d.metrics.activeSessions).set(this.activeSessions.size);
        break;
      case "metrics:inc":
        this.metrics.counter(event.name, event.labels).inc(event.value ?? 1);
        break;
      case "metrics:observe":
        this.metrics.histogram(event.name, event.labels).observe(event.value);
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        break;
      }
    }
  }
}
