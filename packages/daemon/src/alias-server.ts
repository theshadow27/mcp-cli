/**
 * Virtual MCP server that exposes defineAlias aliases as MCP tools.
 *
 * Spawns a Bun Worker running an MCP Server, connects a Client to it via
 * WorkerClientTransport, and provides the client for injection into ServerPool.
 */

import { join } from "node:path";
import type { JsonSchema, ToolInfo } from "@mcp-cli/core";
import { formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AliasToolDef } from "./alias-server-worker";
import type { StateDb } from "./db/state";
import { WorkerClientTransport } from "./worker-transport";

export const ALIAS_SERVER_NAME = "_aliases";

export class AliasServer {
  private worker: Worker | null = null;
  private transport: WorkerClientTransport | null = null;
  private client: Client | null = null;
  private db: StateDb;

  constructor(
    db: StateDb,
    private daemonId?: string,
  ) {
    this.db = db;
  }

  /** Start the worker and connect the MCP client. */
  async start(): Promise<{ client: Client; transport: WorkerClientTransport }> {
    const aliases = this.buildAliasDefs();

    this.worker = new Worker(join(import.meta.dir, "alias-server-worker.ts"));
    this.transport = new WorkerClientTransport(this.worker);
    this.client = new Client({ name: `mcp-cli/${ALIAS_SERVER_NAME}`, version: "0.1.0" });

    // Send init control message before MCP handshake
    this.worker.postMessage({ type: "init", aliases, daemonId: this.daemonId });

    // Connect client (triggers MCP initialize handshake over the transport)
    await this.client.connect(this.transport);

    return { client: this.client, transport: this.transport };
  }

  /** Refresh tool list after alias save/delete. */
  async refresh(): Promise<void> {
    if (!this.worker) return;
    const aliases = this.buildAliasDefs();
    this.worker.postMessage({ type: "refresh", aliases });
  }

  /** Stop the worker. */
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
  }

  /** Build AliasToolDef[] from the database. Only defineAlias aliases with input schemas. */
  private buildAliasDefs(): AliasToolDef[] {
    const aliases = this.db.listAliases();
    const defs: AliasToolDef[] = [];

    for (const alias of aliases) {
      if (alias.aliasType !== "defineAlias") continue;

      const inputSchema = alias.inputSchemaJson ?? { type: "object", properties: {} };
      defs.push({
        name: alias.name,
        description: alias.description || `Alias: ${alias.name}`,
        inputSchema,
        outputSchema: alias.outputSchemaJson,
        filePath: alias.filePath,
      });
    }

    return defs;
  }
}

/** Build ToolInfo[] from DB for pre-populating the pool's tool cache. */
export function buildAliasToolCache(db: StateDb): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  const aliases = db.listAliases();

  for (const alias of aliases) {
    if (alias.aliasType !== "defineAlias") continue;

    const inputSchema = (alias.inputSchemaJson ?? { type: "object", properties: {} }) as Record<string, unknown>;
    tools.set(alias.name, {
      name: alias.name,
      server: ALIAS_SERVER_NAME,
      description: alias.description || `Alias: ${alias.name}`,
      inputSchema,
      signature: formatToolSignature(alias.name, inputSchema as JsonSchema),
    });
  }

  return tools;
}
