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

import { join } from "node:path";
import type { JsonSchema, ToolInfo } from "@mcp-cli/core";
import { formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import type { StateDb } from "./db/state";
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

interface DbEnd {
  type: "db:end";
  sessionId: string;
}

interface ReadyMessage {
  type: "ready";
  port: number;
}

type WorkerEvent = DbUpsert | DbState | DbCost | DbEnd | ReadyMessage;

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

  constructor(db: StateDb) {
    this.db = db;
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    const worker = new Worker(join(import.meta.dir, "claude-session-worker.ts"));
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
      worker.postMessage({ type: "init" });
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

    return { client: this.client, transport: this.transport };
  }

  /** Stop the worker and clean up. */
  async stop(): Promise<void> {
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
  }

  /** Get the WebSocket server port (available after start). */
  get port(): number | null {
    return this.wsPort;
  }

  // ── DB event handling ──

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "ready":
        // Already handled during start(), ignore subsequent
        break;
      case "db:upsert":
        this.db.upsertSession(event.session);
        break;
      case "db:state":
        this.db.updateSessionState(event.sessionId, event.state);
        break;
      case "db:cost":
        this.db.updateSessionCost(event.sessionId, event.cost, event.tokens);
        break;
      case "db:end":
        this.db.endSession(event.sessionId);
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
