/**
 * Virtual MCP server that exposes mock session management tools.
 *
 * Spawns a Bun Worker running an MCP Server that manages MockSession
 * instances — fully in-process, no external binary. Connects a Client
 * via WorkerClientTransport and provides the client for injection into
 * ServerPool. Forwards DB event messages from the worker to StateDb.
 *
 * Simplified version of CodexServer — no crash recovery or auto-restart
 * since this is a testing-only provider.
 */

import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { MOCK_SERVER_NAME, consoleLogger, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { closeClientWithTimeout } from "./close-timeout";
import type { StateDb } from "./db/state";
import { MOCK_TOOLS } from "./mock-session/tools";
import { workerPath } from "./worker-path";
import { WorkerClientTransport } from "./worker-transport";

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

interface ReadyMessage {
  type: "ready";
}

type WorkerEvent = DbUpsert | DbState | DbCost | DbDisconnected | DbEnd | ReadyMessage;

const WORKER_EVENT_TYPES: ReadonlySet<string> = new Set<WorkerEvent["type"]>([
  "ready",
  "db:upsert",
  "db:state",
  "db:cost",
  "db:disconnected",
  "db:end",
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

export class MockServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private db: StateDb;
  private readonly clientFactory: ClientFactory;
  private readonly activeSessions = new Set<string>();
  private readonly sessionAddedAt = new Map<string, number>();
  private readonly logger: Logger;
  private static readonly NO_PID_SESSION_TTL_MS = 10 * 60 * 1000;

  /** Called on worker activity — lets the daemon reset its idle timer. */
  onActivity?: () => void;

  constructor(
    db: StateDb,
    private daemonId?: string,
    clientFactory?: ClientFactory,
    logger?: Logger,
    private handshakeTimeoutMs = 10_000,
  ) {
    this.db = db;
    this.clientFactory = clientFactory ?? (() => new Client({ name: `mcp-cli/${MOCK_SERVER_NAME}`, version: "0.1.0" }));
    this.logger = logger ?? consoleLogger;
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    if (this.worker) throw new Error("start() called while worker is already running");
    const worker = new Worker(workerPath("mock-session-worker.ts"));
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
        if (cleanup()) reject(new Error("Mock session worker startup timeout"));
      }, 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (event.data?.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`Mock session worker init failed: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        if (cleanup()) reject(new Error(`Mock session worker error: ${msg}`));
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

  /** Stop the worker and clean up. */
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
    for (const sessionId of this.activeSessions) {
      try {
        this.db.endSession(sessionId);
      } catch {
        // ignore DB errors during stop
      }
    }
    this.activeSessions.clear();
    this.sessionAddedAt.clear();
  }

  /** True if any mock sessions are active (not yet ended). */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  /** Remove sessions that have exceeded the TTL without activity. */
  pruneDeadSessions(now: number = Date.now()): void {
    for (const sessionId of this.activeSessions) {
      const lastSeen = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - lastSeen > MockServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        this.logger.warn(
          `[mock-server] Pruned stale session ${sessionId} (exceeded ${MockServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
        );
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
        this.logger.warn(`[mock-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
        this.sessionAddedAt.delete(event.sessionId);
        this.db.endSession(event.sessionId);
        break;
    }
  }
}

/** Build static ToolInfo for pre-populating the pool's tool cache. */
export function buildMockToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();

  for (const def of MOCK_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: MOCK_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }

  return tools;
}
