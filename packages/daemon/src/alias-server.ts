/**
 * Virtual MCP server that exposes defineAlias aliases as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Alias execution happens in a subprocess via Bun.spawn for fault isolation.
 */

import type { AliasValidationResult, AliasWorkItemInfo, JsonSchema, ToolInfo } from "@mcp-cli/core";
import { ALIAS_SERVER_NAME, bundleAlias, computeSourceHash, formatToolSignature } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StateDb } from "./db/state";
import { workerPath } from "./worker-path";

/** Max concurrent subprocess executions to prevent fork-bomb scenarios. */
const MAX_CONCURRENT_SUBPROCESSES = 8;

/** Simple counting semaphore for limiting concurrent subprocess spawns. */
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Serializable tool definition */
export interface AliasToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  filePath: string;
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
  private semaphore = new Semaphore(MAX_CONCURRENT_SUBPROCESSES);
  private workItemResolver: ((cwd: string) => AliasWorkItemInfo | null) | null = null;

  constructor(
    db: StateDb,
    private daemonId?: string,
  ) {
    this.db = db;
    this.executorPath = workerPath("alias-executor.ts");
  }

  /**
   * Register a function that maps a caller cwd to its tracked work item.
   * Called in-daemon before spawning the executor, so the subprocess never
   * has to open an IPC connection back to ask the daemon about itself.
   * Late-bound because WorkItemDb starts after AliasServer.
   */
  setWorkItemResolver(resolver: (cwd: string) => AliasWorkItemInfo | null): void {
    this.workItemResolver = resolver;
  }

  /** Start the in-process MCP server and connect a client. */
  async start(): Promise<{ client: Client; transport: Transport }> {
    this.currentAliases = this.buildAliasDefs();

    // Create linked in-memory transports
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    // Create MCP server
    this.server = new Server({ name: ALIAS_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

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
        const result = await this.executeInSubprocess(aliasDef, args ?? {}, undefined, undefined);
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

  /**
   * Call an alias tool with call-chain tracking for cross-alias composition.
   * Used by the IPC server when a callTool request includes a callChain.
   * Returns MCP-formatted result (same shape as pool.callTool).
   */
  async callToolWithChain(
    name: string,
    args: Record<string, unknown>,
    callChain: string[],
    cwd?: string,
    timeoutMs?: number,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const aliasDef = this.currentAliases.find((a) => a.name === name);
    if (!aliasDef) {
      return {
        content: [{ type: "text" as const, text: `Alias "${name}" not found` }],
        isError: true,
      };
    }

    try {
      const result = await this.executeInSubprocess(aliasDef, args, callChain, cwd, timeoutMs);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  /** Execute an alias in a subprocess for fault isolation. */
  private async executeInSubprocess(
    aliasDef: AliasToolDef,
    args: Record<string, unknown>,
    callChain?: string[],
    cwd?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    // Load bundled JS lazily from DB (not held in memory on tool list)
    const dbAlias = this.db.getAlias(aliasDef.name);
    let bundledJs = dbAlias?.bundledJs;
    const sourceHash = dbAlias?.sourceHash;

    // Re-bundle if source hash doesn't match (file was edited outside save)
    if (bundledJs && sourceHash) {
      try {
        const currentHash = await computeSourceHash(aliasDef.filePath);
        if (currentHash !== sourceHash) {
          bundledJs = undefined; // Force re-bundle below
        }
      } catch {
        // Can't read file — use cached bundle but warn
        console.warn(`[alias] cannot read source for "${aliasDef.name}" at ${aliasDef.filePath}, using stale bundle`);
      }
    }

    if (!bundledJs) {
      // Bundle on the fly
      const result = await bundleAlias(aliasDef.filePath);
      bundledJs = result.js;

      // Persist re-bundled JS back to DB so future calls use the cache
      try {
        this.db.saveAlias(
          aliasDef.name,
          aliasDef.filePath,
          aliasDef.description,
          aliasDef.isDefineAlias ? "defineAlias" : "freeform",
          aliasDef.inputSchema ? JSON.stringify(aliasDef.inputSchema) : undefined,
          aliasDef.outputSchema ? JSON.stringify(aliasDef.outputSchema) : undefined,
          bundledJs,
          result.sourceHash,
        );
      } catch {
        // Non-fatal: DB persist failed, bundle still usable in-memory
      }
    }

    // Resolve the work item *here* (in the daemon) rather than inside the
    // executor subprocess. Keeps the re-entrant IPC call off the hot path.
    // Errors are swallowed — alias execution should proceed even when the
    // lookup fails (detached HEAD, non-git cwd, DB hiccup).
    let workItem: AliasWorkItemInfo | null = null;
    if (cwd && this.workItemResolver) {
      try {
        workItem = this.workItemResolver(cwd);
      } catch {
        workItem = null;
      }
    }

    const payload = JSON.stringify({
      bundledJs,
      input: args,
      isDefineAlias: aliasDef.isDefineAlias,
      aliasName: aliasDef.name,
      ...(callChain && callChain.length > 0 ? { callChain } : {}),
      ...(cwd ? { cwd } : {}),
      ...(workItem ? { workItem } : {}),
    });

    return this.spawnExecutor(payload, timeoutMs ?? 30_000) as Promise<unknown>;
  }

  /** Validate bundled JS in a subprocess, returning structured results. */
  async validateInSubprocess(bundledJs: string): Promise<AliasValidationResult> {
    const payload = JSON.stringify({
      bundledJs,
      input: null,
      isDefineAlias: true,
      mode: "validate",
    });

    return this.spawnExecutor(payload, 10_000) as Promise<AliasValidationResult>;
  }

  /** Spawn executor subprocess with semaphore-limited concurrency. */
  private async spawnExecutor(stdinPayload: string, timeoutMs: number): Promise<unknown> {
    await this.semaphore.acquire();
    try {
      const proc = Bun.spawn([process.execPath, this.executorPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.stdin.write(stdinPayload);
      proc.stdin.end();

      const killTimeout = setTimeout(() => {
        proc.kill("SIGKILL");
      }, timeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      clearTimeout(killTimeout);

      // Surface subprocess warnings (e.g. output validation) even on success
      if (exitCode === 0 && stderr.trim()) {
        console.warn(`[alias] executor stderr: ${stderr.trim()}`);
      }

      if (exitCode !== 0) {
        if (stdout) {
          try {
            const parsed = JSON.parse(stdout) as { error?: string };
            if (parsed.error) throw new Error(parsed.error);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
          }
        }
        throw new Error(stderr || `Alias executor exited with code ${exitCode}`);
      }

      const parsed = JSON.parse(stdout) as { result: unknown; error?: string };
      if (parsed.error) throw new Error(parsed.error);
      return parsed.result;
    } finally {
      this.semaphore.release();
    }
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
