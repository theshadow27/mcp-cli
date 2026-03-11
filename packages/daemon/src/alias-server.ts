/**
 * Virtual MCP server that exposes defineAlias aliases as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Alias execution happens in a subprocess via Bun.spawn for fault isolation.
 */

import type { JsonSchema, ToolInfo } from "@mcp-cli/core";
import { computeSourceHash, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StateDb } from "./db/state";
import { workerPath } from "./worker-path";

export const ALIAS_SERVER_NAME = "_aliases";

/** Serializable tool definition */
export interface AliasToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  filePath: string;
  bundledJs?: string;
  sourceHash?: string;
  isDefineAlias: boolean;
}

export class AliasServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;
  private currentAliases: AliasToolDef[] = [];
  private db: StateDb;
  private executorPath: string;

  constructor(
    db: StateDb,
    private daemonId?: string,
  ) {
    this.db = db;
    this.executorPath = workerPath("alias-executor.ts");
  }

  /** Start the in-process MCP server and connect a client. */
  async start(): Promise<{ client: Client; transport: Transport }> {
    this.currentAliases = this.buildAliasDefs();

    // Create linked in-memory transports
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    // Create MCP server
    this.server = new Server({ name: "_aliases", version: "0.1.0" }, { capabilities: { tools: {} } });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.currentAliases.map((a) => ({
        name: a.name,
        description: a.description,
        inputSchema: a.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const aliasDef = this.currentAliases.find((a) => a.name === name);
      if (!aliasDef) {
        return {
          content: [{ type: "text" as const, text: `Alias "${name}" not found` }],
          isError: true,
        };
      }

      try {
        const result = await this.executeInSubprocess(aliasDef, args ?? {});
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });

    // Connect server and client
    await this.server.connect(serverTransport);
    this.client = new Client({ name: `mcp-cli/${ALIAS_SERVER_NAME}`, version: "0.1.0" });
    await this.client.connect(clientTransport);

    return { client: this.client, transport: this.clientTransport };
  }

  /** Refresh tool list after alias save/delete. */
  async refresh(): Promise<void> {
    if (!this.server) return;
    this.currentAliases = this.buildAliasDefs();
    await this.server.notification({ method: "notifications/tools/list_changed" });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.server?.close();
    } catch {
      // ignore close errors
    }
    this.server = null;
    this.client = null;
    this.serverTransport = null;
    this.clientTransport = null;
  }

  /** Execute an alias in a subprocess for fault isolation. */
  private async executeInSubprocess(aliasDef: AliasToolDef, args: Record<string, unknown>): Promise<unknown> {
    let bundledJs = aliasDef.bundledJs;

    // Re-bundle if source hash doesn't match (file was edited outside save)
    if (bundledJs && aliasDef.sourceHash) {
      try {
        const currentHash = await computeSourceHash(aliasDef.filePath);
        if (currentHash !== aliasDef.sourceHash) {
          bundledJs = undefined; // Force re-bundle below
        }
      } catch {
        // Can't read file — use cached bundle
      }
    }

    if (!bundledJs) {
      // Bundle on the fly
      const { bundleAlias } = await import("@mcp-cli/core");
      const result = await bundleAlias(aliasDef.filePath);
      bundledJs = result.js;
    }

    const input = JSON.stringify({
      bundledJs,
      input: args,
      isDefineAlias: aliasDef.isDefineAlias,
    });

    const proc = Bun.spawn(["bun", this.executorPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Try to parse error from stdout first
      try {
        const parsed = JSON.parse(stdout) as { error?: string };
        if (parsed.error) throw new Error(parsed.error);
      } catch (e) {
        if (e instanceof Error && e.message !== stdout) throw e;
      }
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr || `Alias executor exited with code ${exitCode}`);
    }

    const parsed = JSON.parse(stdout) as { result: unknown; error?: string };
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed.result;
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
        bundledJs: alias.bundledJs,
        sourceHash: alias.sourceHash,
        isDefineAlias: true,
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
