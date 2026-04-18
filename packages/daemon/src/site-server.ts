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

  /** Called on worker activity — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    private daemonId?: string,
    clientFactory?: ClientFactory,
    workerFactory?: WorkerFactory,
    logger?: Logger,
    private handshakeTimeoutMs = 10_000,
  ) {
    this.clientFactory = clientFactory ?? (() => new Client({ name: `mcp-cli/${SITE_SERVER_NAME}`, version: "0.1.0" }));
    this.workerFactory = workerFactory ?? ((scriptPath: string) => new Worker(scriptPath));
    this.logger = logger ?? consoleLogger;
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
    await closeClientWithTimeout(this.client);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.transport = null;
    this.client = null;
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
