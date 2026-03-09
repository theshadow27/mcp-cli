/**
 * HTTP-over-Unix-socket IPC server.
 *
 * Listens on ~/.mcp-cli/mcpd.sock for JSON requests from the `mcx` CLI.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcError, IpcMethod, IpcRequest, IpcResponse, ResolvedConfig } from "@mcp-cli/core";
import {
  CallToolParamsSchema,
  DeleteAliasParamsSchema,
  GetAliasParamsSchema,
  GetDaemonLogsParamsSchema,
  GetLogsParamsSchema,
  GetToolInfoParamsSchema,
  GrepToolsParamsSchema,
  IPC_ERROR,
  ListToolsParamsSchema,
  MarkReadParamsSchema,
  PROTOCOL_VERSION,
  ReadMailParamsSchema,
  ReplyToMailParamsSchema,
  RestartServerParamsSchema,
  SaveAliasParamsSchema,
  SendMailParamsSchema,
  TriggerAuthParamsSchema,
  WaitForMailParamsSchema,
  hardenFile,
  isDefineAlias,
  options,
  safeAliasPath,
} from "@mcp-cli/core";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod/v4";
import type { AliasServer } from "./alias-server";
import { startCallbackServer } from "./auth/callback-server";
import { McpOAuthProvider } from "./auth/oauth-provider";
import { getDaemonLogLines } from "./daemon-log";
import type { StateDb } from "./db/state";
import { metrics } from "./metrics";
import type { ServerPool } from "./server-pool";

type RequestHandler = (params: unknown) => Promise<unknown>;

export class IpcServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socketPath = options.SOCKET_PATH;
  private handlers = new Map<IpcMethod, RequestHandler>();
  private onActivity: () => void;
  private onRequestComplete: () => void;
  private onShutdown: () => void;

  private onReloadConfig: (() => Promise<void>) | null = null;
  private aliasServer: AliasServer | null = null;

  constructor(
    private pool: ServerPool,
    private config: ResolvedConfig,
    private db: StateDb,
    aliasServer: AliasServer | null,
    options: {
      onActivity: () => void;
      onRequestComplete?: () => void;
      onShutdown?: () => void;
      onReloadConfig?: () => Promise<void>;
    },
  ) {
    this.onActivity = options.onActivity;
    this.onRequestComplete = options.onRequestComplete ?? (() => {});
    this.onShutdown = options.onShutdown ?? (() => process.exit(0));
    this.onReloadConfig = options.onReloadConfig ?? null;
    this.aliasServer = aliasServer;
    this.registerHandlers();
  }

  /** Start listening on the Unix socket */
  start(socketPath = options.SOCKET_PATH): void {
    this.socketPath = socketPath;

    // Remove stale socket file
    try {
      unlinkSync(socketPath);
    } catch {
      // doesn't exist, fine
    }

    const onActivity = this.onActivity;
    const onRequestComplete = this.onRequestComplete;
    const dispatch = this.dispatch.bind(this);

    this.server = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        const url = new URL(req.url);

        // GET /metrics — Prometheus text exposition format
        if (url.pathname === "/metrics" && req.method === "GET") {
          return new Response(metrics.toPrometheusText(), {
            headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
          });
        }

        if (req.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        if (url.pathname !== "/rpc") {
          return new Response("Not Found", { status: 404 });
        }

        onActivity();

        let request: IpcRequest;
        try {
          request = await req.json();
        } catch {
          onRequestComplete();
          const error: IpcResponse = {
            id: "unknown",
            error: { code: IPC_ERROR.PARSE_ERROR, message: "Invalid JSON" },
          };
          return Response.json(error, { status: 400 });
        }

        try {
          const result = await dispatch(request);
          const response: IpcResponse = { id: request.id, result };
          return Response.json(response);
        } catch (err) {
          const response: IpcResponse = {
            id: request.id,
            error: toIpcError(err),
          };
          return Response.json(response);
        } finally {
          onRequestComplete();
        }
      },
    });

    // Restrict socket to owner-only access (0600)
    hardenFile(socketPath);

    console.error(`[ipc] Listening on ${socketPath}`);
  }

  /** Stop listening and clean up socket */
  stop(): void {
    this.server?.stop(true);
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  // -- Dispatch --

  private async dispatch(request: IpcRequest): Promise<unknown> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      throw Object.assign(new Error(`Unknown method: ${request.method}`), {
        code: IPC_ERROR.METHOD_NOT_FOUND,
      });
    }

    const labels = { method: request.method };
    metrics.counter("mcpd_ipc_requests_total", labels).inc();
    const stopTimer = metrics.histogram("mcpd_ipc_request_duration_ms", labels).startTimer();

    try {
      const result = await handler(request.params);
      return result;
    } catch (err) {
      metrics.counter("mcpd_ipc_errors_total", labels).inc();
      throw err;
    } finally {
      stopTimer();
    }
  }

  // -- Handler registration --

  private registerHandlers(): void {
    this.handlers.set("ping", async () => ({ pong: true, time: Date.now(), protocolVersion: PROTOCOL_VERSION }));

    this.handlers.set("status", async () => {
      const servers = this.pool.listServers();
      const usageStats = this.db.getUsageStats();

      // Compute per-server aggregates
      for (const server of servers) {
        const serverStats = usageStats.filter((s) => s.serverName === server.name);
        if (serverStats.length > 0) {
          server.callCount = serverStats.reduce((sum, s) => sum + s.callCount, 0);
          server.errorCount = serverStats.reduce((sum, s) => sum + s.errorCount, 0);
          const totalDuration = serverStats.reduce((sum, s) => sum + s.totalDurationMs, 0);
          server.avgDurationMs = Math.round(totalDuration / server.callCount);
        }
      }

      return {
        pid: process.pid,
        uptime: process.uptime(),
        protocolVersion: PROTOCOL_VERSION,
        servers,
        dbPath: options.DB_PATH,
        usageStats,
      };
    });

    this.handlers.set("listServers", async () => this.pool.listServers());

    this.handlers.set("listTools", async (params) => {
      const { server } = ListToolsParamsSchema.parse(params ?? {});
      return this.pool.listTools(server);
    });

    this.handlers.set("getToolInfo", async (params) => {
      const { server, tool } = GetToolInfoParamsSchema.parse(params);
      return this.pool.getToolInfo(server, tool);
    });

    this.handlers.set("grepTools", async (params) => {
      const { pattern } = GrepToolsParamsSchema.parse(params);
      return this.pool.grepTools(pattern);
    });

    this.handlers.set("callTool", async (params) => {
      const { server, tool, arguments: args } = CallToolParamsSchema.parse(params);
      const toolLabels = { server, tool };
      const start = Date.now();
      try {
        const result = await this.pool.callTool(server, tool, args);
        const durationMs = Date.now() - start;
        this.db.recordUsage(server, tool, durationMs, true);
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        this.db.recordUsage(server, tool, durationMs, false, err instanceof Error ? err.message : String(err));
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.counter("mcpd_tool_errors_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(durationMs);
        throw err;
      }
    });

    this.handlers.set("triggerAuth", async (params) => {
      const { server } = TriggerAuthParamsSchema.parse(params);
      const serverUrl = this.pool.getServerUrl(server);
      if (!serverUrl) {
        throw Object.assign(new Error(`Server "${server}" not found or is not a remote (SSE/HTTP) server`), {
          code: IPC_ERROR.SERVER_NOT_FOUND,
        });
      }

      const poolDb = this.pool.getDb();
      if (!poolDb) {
        throw Object.assign(new Error("Database not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }

      // Read OAuth config from server configuration
      const serverConfig = this.pool.getServerConfig(server);
      const { clientId, clientSecret, callbackPort } = serverConfig ?? {};

      // Start callback server for OAuth redirect (use configured port if available)
      const callback = startCallbackServer(callbackPort);
      try {
        // Create provider with callback URL and config-level OAuth credentials
        const provider = new McpOAuthProvider(server, serverUrl, poolDb, { clientId, clientSecret, callbackPort });
        provider.setRedirectUrl(callback.url);

        // Run the SDK auth orchestrator
        const result = await auth(provider, { serverUrl });

        if (result === "AUTHORIZED") {
          // Already authorized (tokens were valid) — restart server to reconnect
          await this.pool.restart(server);
          return { ok: true, message: "Already authorized" };
        }

        // result === "REDIRECT" — browser was opened, wait for callback
        const code = await callback.waitForCode;

        // Exchange code for tokens
        await auth(provider, { serverUrl, authorizationCode: code });

        // Reconnect with new tokens
        await this.pool.restart(server);

        return { ok: true, message: "Authenticated successfully" };
      } finally {
        callback.stop();
      }
    });

    this.handlers.set("restartServer", async (params) => {
      const { server } = RestartServerParamsSchema.parse(params ?? {});
      await this.pool.restart(server);
      return { ok: true };
    });

    this.handlers.set("getConfig", async () => {
      const servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }> = {};
      const statusMap = new Map(this.pool.listServers().map((s) => [s.name, s]));
      for (const [name, resolved] of this.config.servers) {
        const status = statusMap.get(name);
        servers[name] = {
          transport: status?.transport ?? "unknown",
          source: resolved.source.file,
          scope: resolved.source.scope,
          toolCount: status?.toolCount ?? 0,
        };
      }
      return {
        servers,
        sources: this.config.sources,
      };
    });

    this.handlers.set("listAliases", async () => {
      return this.db.listAliases();
    });

    this.handlers.set("getAlias", async (params) => {
      const { name } = GetAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (!alias) return null;
      try {
        const script = readFileSync(alias.filePath, "utf-8");
        return { ...alias, script };
      } catch {
        return { ...alias, script: "" };
      }
    });

    this.handlers.set("saveAlias", async (params) => {
      const { name, script, description } = SaveAliasParamsSchema.parse(params);
      const filePath = safeAliasPath(name);
      mkdirSync(options.ALIASES_DIR, { recursive: true });

      const isStructured = isDefineAlias(script);

      let finalScript: string;
      if (isStructured) {
        // defineAlias scripts get everything via the virtual module — no auto-import
        finalScript = script;
      } else {
        // Freeform: auto-prepend import if not present (existing behavior)
        const hasImport = /import\s.*from\s+["']mcp-cli["']/.test(script);
        finalScript = hasImport ? script : `import { mcp, args, file, json } from "mcp-cli";\n${script}`;
      }

      writeFileSync(filePath, finalScript, "utf-8");

      const aliasType = isStructured ? "defineAlias" : "freeform";

      // For defineAlias scripts, extract metadata via worker
      if (isStructured) {
        try {
          const meta = await extractAliasMetadata(filePath);
          this.db.saveAlias(
            name,
            filePath,
            meta.description || description,
            aliasType,
            meta.inputSchema ? JSON.stringify(meta.inputSchema) : undefined,
            meta.outputSchema ? JSON.stringify(meta.outputSchema) : undefined,
          );
        } catch {
          // Worker extraction failed — save with sentinel-detected type only
          this.db.saveAlias(name, filePath, description, aliasType);
        }
      } else {
        this.db.saveAlias(name, filePath, description, aliasType);
      }

      // Refresh virtual alias server so new tool is immediately visible
      await this.aliasServer?.refresh();
      return { ok: true, filePath };
    });

    this.handlers.set("deleteAlias", async (params) => {
      const { name } = DeleteAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (alias) {
        try {
          unlinkSync(alias.filePath);
        } catch {
          // file already gone, fine
        }
        this.db.deleteAlias(name);
      }
      // Refresh virtual alias server so deleted tool is removed
      await this.aliasServer?.refresh();
      return { ok: true };
    });

    this.handlers.set("getLogs", async (params) => {
      const { server, limit, since } = GetLogsParamsSchema.parse(params);

      // Fast path: in-memory ring buffer (no since filter)
      if (since === undefined) {
        const lines = this.pool.getStderrLines(server, limit);
        return {
          server,
          lines: lines.map((l) => ({ timestamp: l.timestamp, line: l.line })),
        };
      }

      // Fall back to DB for since-filtered queries
      const dbLogs = this.db.getServerLogs(server, limit, since);
      return {
        server,
        lines: dbLogs.map((l) => ({ timestamp: l.timestampMs, line: l.line })),
      };
    });

    this.handlers.set("getDaemonLogs", async (params) => {
      const { limit, since } = GetDaemonLogsParamsSchema.parse(params ?? {});
      let lines = getDaemonLogLines(limit).map((l) => ({
        timestamp: l.timestamp,
        line: l.line,
      }));
      if (since !== undefined) {
        lines = lines.filter((l) => l.timestamp > since);
      }
      return { lines };
    });

    // -- Mail handlers --

    this.handlers.set("sendMail", async (params) => {
      const { sender, recipient, subject, body, replyTo } = SendMailParamsSchema.parse(params);
      const id = this.db.insertMail(sender, recipient, subject, body, replyTo);
      return { id };
    });

    this.handlers.set("readMail", async (params) => {
      const { recipient, unreadOnly, limit } = ReadMailParamsSchema.parse(params ?? {});
      const messages = this.db.readMail(recipient, unreadOnly, limit);
      return { messages };
    });

    this.handlers.set("waitForMail", async (params) => {
      const { recipient, timeout } = WaitForMailParamsSchema.parse(params ?? {});
      // Server-side timeout capped at 30s to stay under IPC client's 60s timeout
      const maxWait = Math.min((timeout ?? 30) * 1000, 30_000);
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        const msg = this.db.getNextUnread(recipient);
        if (msg) {
          this.db.markMailRead(msg.id);
          return { message: msg };
        }
        await Bun.sleep(500);
      }
      return { message: null };
    });

    this.handlers.set("replyToMail", async (params) => {
      const { id, sender, body, subject } = ReplyToMailParamsSchema.parse(params);
      const original = this.db.getMailById(id);
      if (!original) {
        throw Object.assign(new Error(`Mail message ${id} not found`), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }
      const replySubject = subject ?? (original.subject ? `Re: ${original.subject}` : undefined);
      const newId = this.db.insertMail(sender, original.sender, replySubject, body, id);
      return { id: newId };
    });

    this.handlers.set("markRead", async (params) => {
      const { id } = MarkReadParamsSchema.parse(params);
      this.db.markMailRead(id);
      return {};
    });

    this.handlers.set("reloadConfig", async () => {
      if (!this.onReloadConfig) {
        throw Object.assign(new Error("Config reload not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }
      await this.onReloadConfig();
      return { ok: true };
    });

    this.handlers.set("getMetrics", async () => {
      return metrics.toJSON();
    });

    this.handlers.set("shutdown", async () => {
      // Schedule graceful shutdown after response is sent
      setTimeout(() => this.onShutdown(), 100);
      return { ok: true };
    });
  }
}

// -- Helpers --

interface AliasMetadata {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** Extract metadata from a defineAlias script using a Bun Worker */
function extractAliasMetadata(aliasPath: string): Promise<AliasMetadata> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dir, "alias-worker.ts"));
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Alias metadata extraction timed out"));
    }, 5_000);

    worker.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      worker.terminate();
      const data = event.data as AliasMetadata | { error: string };
      if ("error" in data) {
        reject(new Error(data.error));
      } else {
        resolve(data);
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(err);
    };

    worker.postMessage({ aliasPath });
  });
}

function toIpcError(err: unknown): IpcError {
  if (err instanceof z.ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { code: IPC_ERROR.INVALID_PARAMS, message: `Invalid params: ${detail}` };
  }
  if (err instanceof Error) {
    const code = (err as unknown as { code?: number }).code;
    const data = (err as unknown as { data?: unknown }).data;
    return {
      code: typeof code === "number" ? code : IPC_ERROR.INTERNAL_ERROR,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }
  return { code: IPC_ERROR.INTERNAL_ERROR, message: String(err) };
}
