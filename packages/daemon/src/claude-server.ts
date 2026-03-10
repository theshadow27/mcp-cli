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

function isWorkerEvent(data: unknown): data is WorkerEvent {
  return typeof data === "object" && data !== null && "type" in data && !("jsonrpc" in data);
}

// ── Server ──

export class ClaudeServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private db: StateDb;
  private wsPort: number | null = null;
  private readonly activeSessions = new Set<string>();
  private restartInProgress = false;
  private stopped = false;
  private readonly crashTimestamps: number[] = [];
  private static readonly MAX_CRASHES = 3;
  private static readonly CRASH_WINDOW_MS = 60_000;

  /** Called after a successful auto-restart with the new client and transport. */
  onRestarted?: (client: Client, transport: WorkerClientTransport) => void;

  constructor(
    db: StateDb,
    private daemonId?: string,
  ) {
    this.db = db;
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    this.stopped = false;
    const worker = new Worker(workerPath("claude-session-worker.ts"));
    this.worker = worker;

    // Wait for the worker to report ready with its WS port
    this.wsPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Claude session worker startup timeout")), 10_000);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          clearTimeout(timeout);
          resolve(event.data.port as number);
        }
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        clearTimeout(timeout);
        const msg = event instanceof ErrorEvent ? event.message : String(event);
        reject(new Error(`Claude session worker error: ${msg}`));
      };
      // Send init to start the worker
      worker.postMessage({ type: "init", daemonId: this.daemonId });
    });

    // Now set up MCP transport
    this.transport = new WorkerClientTransport(this.worker);
    this.client = new Client({ name: `mcp-cli/${CLAUDE_SERVER_NAME}`, version: "0.1.0" });

    // Connect triggers MCP handshake (calls transport.start() which sets worker.onmessage)
    await this.client.connect(this.transport);

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

    // Attach post-startup crash detection
    this.attachCrashDetection(worker);

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
    this.worker?.terminate();
    this.worker = null;
    this.transport = null;
    this.client = null;
    this.wsPort = null;
    this.activeSessions.clear();
  }

  /** Get the WebSocket server port (available after start). */
  get port(): number | null {
    return this.wsPort;
  }

  /** True if any WebSocket sessions are active (not yet ended). */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  // ── Crash detection ──

  /** Attach post-startup error listener to detect worker crashes. */
  private attachCrashDetection(worker: Worker): void {
    worker.addEventListener("error", (event: ErrorEvent | Event) => {
      // Only handle if this is still our active worker
      if (this.worker !== worker) return;
      const msg = event instanceof ErrorEvent ? event.message : "unknown error";
      this.handleWorkerCrash(`worker error: ${msg}`);
    });
  }

  /** Handle a worker crash: end orphaned sessions and attempt auto-restart. */
  private async handleWorkerCrash(reason: string): Promise<void> {
    if (this.restartInProgress || this.stopped) return;
    this.restartInProgress = true;

    console.error(`[claude-server] Worker crash detected: ${reason}`);

    // Mark all tracked sessions as ended in SQLite
    for (const sessionId of this.activeSessions) {
      console.error(`[claude-server] Ending orphaned session: ${sessionId}`);
      this.db.endSession(sessionId);
    }
    this.activeSessions.clear();

    // Clear stale references (don't terminate — worker is already dead)
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
      return;
    }

    // Auto-restart
    try {
      console.error("[claude-server] Restarting worker...");
      const { client, transport } = await this.start();
      console.error(`[claude-server] Worker restarted successfully (port ${this.wsPort})`);
      // Notify connected MCP clients that the tool list may have changed
      // (this.worker is set by start() but TS can't track cross-method mutation)
      (this.worker as Worker | null)?.postMessage({ type: "tools_changed" });
      this.onRestarted?.(client, transport);
    } catch (err) {
      console.error(`[claude-server] Failed to restart worker: ${err}`);
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
        this.db.upsertSession(event.session);
        metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        metrics.counter("mcpd_sessions_total").inc();
        break;
      case "db:state":
        this.db.updateSessionState(event.sessionId, event.state);
        break;
      case "db:cost":
        this.db.updateSessionCost(event.sessionId, event.cost, event.tokens);
        metrics.counter("mcpd_session_cost_usd").inc(event.cost);
        break;
      case "db:disconnected":
        // Session lost transport but was NOT bye'd — keep in activeSessions
        console.error(`[claude-server] Session ${event.sessionId} disconnected: ${event.reason}`);
        this.db.updateSessionState(event.sessionId, "disconnected");
        break;
      case "db:end":
        this.activeSessions.delete(event.sessionId);
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
