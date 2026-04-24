/**
 * Virtual MCP server that exposes the site-worker's tools to the ServerPool.
 *
 * Mirrors MockServer / CodexServer: spawns a Bun Worker, waits for the
 * "ready" handshake, and connects an MCP Client over WorkerClientTransport.
 * The worker is started lazily (only when any site is configured) so users
 * without sites pay no startup cost.
 */

import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { SITE_SERVER_NAME, consoleLogger, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { closeClientWithTimeout } from "./close-timeout";
import {
  DEFAULT_RESTART_POLICY,
  type RestartPolicy,
  getBackoffDelay,
  maxAttempts,
  shouldRestart,
} from "./restart-policy";
import { SITE_TOOLS } from "./site/tools";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

interface ReadyMessage {
  type: "ready";
}
interface ErrorMessage {
  type: "error";
  message: string;
}

type WorkerEvent = ReadyMessage | ErrorMessage;

const WORKER_EVENT_TYPES: ReadonlySet<string> = new Set<WorkerEvent["type"]>(["ready", "error"]);

export function isWorkerEvent(data: unknown): data is WorkerEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    WORKER_EVENT_TYPES.has((data as { type: string }).type)
  );
}

type ClientFactory = () => Client;
type WorkerFactory = (scriptPath: string) => Worker;

export class SiteServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private readonly clientFactory: ClientFactory;
  private readonly workerFactory: WorkerFactory;
  private readonly logger: Logger;
  private readonly restartPolicy: RestartPolicy;
  private readonly crashTimestamps: number[] = [];
  private crashErrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  private restartInProgress = false;
  private pendingCrashReason: string | null = null;
  private stopped = false;

  /** Called after a successful auto-restart with the new client and transport. */
  onRestarted?: (client: Client, transport: WorkerClientTransport) => void;

  /** Called when the crash-restart loop exhausts its budget and gives up permanently. */
  onPermanentlyFailed?: () => void;

  /** Called on worker activity — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    private daemonId?: string,
    clientFactory?: ClientFactory,
    workerFactory?: WorkerFactory,
    logger?: Logger,
    private handshakeTimeoutMs = 10_000,
    restartPolicy?: RestartPolicy,
  ) {
    this.clientFactory = clientFactory ?? (() => new Client({ name: `mcp-cli/${SITE_SERVER_NAME}`, version: "0.1.0" }));
    this.workerFactory = workerFactory ?? ((scriptPath: string) => new Worker(scriptPath));
    this.logger = logger ?? consoleLogger;
    this.restartPolicy = restartPolicy ?? DEFAULT_RESTART_POLICY;
  }

  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    if (this.worker) throw new Error("SiteServer.start() called while worker is already running");
    const worker = this.workerFactory(workerPath("site-worker.ts"));
    this.worker = worker;

    // Wait for the worker to report ready
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        try {
          worker.terminate();
        } catch {
          /* already dead */
        }
        this.worker = null;
        return true;
      };
      const timeout = setTimeout(() => {
        if (cleanup()) reject(new Error(`Site worker startup timeout (${this.handshakeTimeoutMs}ms)`));
      }, this.handshakeTimeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          if (cleanup()) reject(new Error(`Site worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`Site worker error: ${msg}`));
      };
      worker.postMessage({ type: "init", daemonId: this.daemonId });
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
            reject(new Error(`Site MCP handshake timeout (${this.handshakeTimeoutMs}ms)`));
          }, this.handshakeTimeoutMs);
        }),
      ]);
      clearTimeout(handshakeTimer);

      // Intercept site-level DB events on their way through (none today, but keeps the pattern aligned with other backends).
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
        /* ignore */
      }
      try {
        worker.terminate();
      } catch {
        /* already dead */
      }
      this.worker = null;
      this.transport = null;
      this.client = null;
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
    this.crashTimestamps.length = 0;
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
    if (this.stopped) return;
    if (this.restartInProgress) {
      this.pendingCrashReason = reason;
      return;
    }
    this.restartInProgress = true;

    this.logger.error(`[site-server] Worker crash detected: ${reason}`);

    await closeClientWithTimeout(this.client);

    if (this.worker) {
      this.cleanupWorkerHandlers(this.worker);
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;

    // Outer try/finally owns restartInProgress = false for ALL exit paths, including
    // the shouldRestart early-return below (previously that path reset it manually,
    // making the code fragile against future changes).
    try {
      if (!shouldRestart(this.crashTimestamps, this.restartPolicy)) {
        this.logger.error(
          `[site-server] ${this.crashTimestamps.length} crashes in ${this.restartPolicy.crashWindowMs / 1000}s — giving up auto-restart`,
        );
        this.stopped = true;
        this.onPermanentlyFailed?.();
        return;
      }

      const totalAttempts = maxAttempts(this.restartPolicy);
      let lastErr: unknown;

      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        if (attempt > 0) {
          const delay = getBackoffDelay(attempt, this.restartPolicy.backoffDelaysMs);
          this.logger.warn(`[site-server] Retry ${attempt}/${totalAttempts - 1} after ${delay}ms...`);
          await Bun.sleep(delay);
        }

        if (this.stopped) {
          this.logger.info("[site-server] Server stopped during restart backoff — aborting");
          return;
        }

        // Separate start() from onRestarted so that a throw in the callback
        // does NOT look like a failed start() and trigger a spurious retry
        // against an already-running worker (which would leak the worker).
        let startResult: { client: Client; transport: WorkerClientTransport } | undefined;
        try {
          this.logger.info("[site-server] Restarting worker...");
          startResult = await this.start();
        } catch (err) {
          lastErr = err;
          this.logger.error(`[site-server] Restart attempt ${attempt + 1} failed: ${err}`);
        }

        if (startResult) {
          this.logger.info("[site-server] Worker restarted successfully");
          try {
            this.onRestarted?.(startResult.client, startResult.transport);
          } catch (err) {
            // Registration callback failed — the worker is running but unregistered.
            // Tear it down via stop() rather than leaving it as an orphan.
            this.logger.error(`[site-server] onRestarted callback threw: ${err} — stopping server`);
            await this.stop();
          }
          return;
        }
      }

      this.logger.error(`[site-server] All ${totalAttempts} restart attempts failed (last: ${lastErr}) — giving up`);
      this.stopped = true;
      this.onPermanentlyFailed?.();
    } finally {
      this.restartInProgress = false;
      if (this.pendingCrashReason !== null && !this.stopped) {
        const pending = this.pendingCrashReason;
        this.pendingCrashReason = null;
        await this.handleWorkerCrash(pending);
      }
    }
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    if (event.type === "error") {
      this.logger.error(`[site-server] worker error: ${event.message}`);
    }
    this.onActivity?.();
  }
}

/** Build static ToolInfo for pre-populating the pool's tool cache (mcx ls works before the worker boots). */
export function buildSiteToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const def of SITE_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: SITE_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }
  return tools;
}
