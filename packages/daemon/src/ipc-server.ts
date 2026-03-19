/**
 * HTTP-over-Unix-socket IPC server.
 *
 * Listens on ~/.mcp-cli/mcpd.sock for JSON requests from the `mcx` CLI.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type {
  IpcError,
  IpcMethod,
  IpcRequest,
  IpcResponse,
  LiveSpan,
  Logger,
  ResolvedConfig,
  ServeInstanceInfo,
  ServerAuthStatus,
  ToolInfo,
} from "@mcp-cli/core";
import {
  AuthStatusParamsSchema,
  BUILD_VERSION,
  CallToolParamsSchema,
  CheckAliasParamsSchema,
  DeleteAliasParamsSchema,
  GetAliasParamsSchema,
  GetDaemonLogsParamsSchema,
  GetLogsParamsSchema,
  GetSpansParamsSchema,
  GetToolInfoParamsSchema,
  GrepToolsParamsSchema,
  IPC_ERROR,
  ListToolsParamsSchema,
  MarkReadParamsSchema,
  MarkSpansExportedParamsSchema,
  PROTOCOL_VERSION,
  PruneSpansParamsSchema,
  ReadMailParamsSchema,
  RecordAliasRunParamsSchema,
  RegisterServeParamsSchema,
  ReplyToMailParamsSchema,
  RestartServerParamsSchema,
  SaveAliasParamsSchema,
  SendMailParamsSchema,
  ShutdownParamsSchema,
  TouchAliasParamsSchema,
  TriggerAuthParamsSchema,
  UnregisterServeParamsSchema,
  WaitForMailParamsSchema,
  bundleAlias,
  consoleLogger,
  hardenFile,
  isDefineAlias,
  options,
  safeAliasPath,
  startSpan,
} from "@mcp-cli/core";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod/v4";
import type { AliasServer } from "./alias-server";
import { startCallbackServer } from "./auth/callback-server";
import { McpOAuthProvider } from "./auth/oauth-provider";
import { getDaemonLogLines } from "./daemon-log";
import type { StateDb } from "./db/state";
import { metrics } from "./metrics";
import { getPortHolder } from "./port-holder";
import type { ServerPool } from "./server-pool";

/** Per-request context passed to every handler (fixes race condition on shared state). */
export interface RequestContext {
  span: LiveSpan;
}

type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

export class IpcServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socketPath = options.SOCKET_PATH;
  private handlers = new Map<IpcMethod, RequestHandler>();
  private onActivity: () => void;
  private onRequestComplete: () => void;
  private onShutdown: () => void;
  private inflightCount = 0;
  private draining = false;
  private shutdownScheduled = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimeoutMs: number;

  private serveInstances = new Map<string, ServeInstanceInfo>();
  private onReloadConfig: (() => Promise<void>) | null = null;
  private getWsPortInfo: (() => { actual: number | null; expected: number }) | null = null;
  private aliasServer: AliasServer | null = null;
  private daemonId: string;
  private startedAt: number;
  private logger: Logger;

  constructor(
    private pool: ServerPool,
    private config: ResolvedConfig,
    private db: StateDb,
    aliasServer: AliasServer | null,
    options: {
      daemonId: string;
      startedAt: number;
      onActivity: () => void;
      onRequestComplete?: () => void;
      onShutdown?: () => void;
      onReloadConfig?: () => Promise<void>;
      logger?: Logger;
      /** Returns the current and expected WS port for status reporting. */
      getWsPortInfo?: () => { actual: number | null; expected: number };
      /** Max ms to wait for in-flight requests before forcing shutdown (default 5000) */
      drainTimeoutMs?: number;
    },
  ) {
    this.daemonId = options.daemonId;
    this.startedAt = options.startedAt;
    this.onActivity = options.onActivity;
    this.onRequestComplete = options.onRequestComplete ?? (() => {});
    this.onShutdown = options.onShutdown ?? (() => process.exit(0));
    this.onReloadConfig = options.onReloadConfig ?? null;
    this.aliasServer = aliasServer;
    this.logger = options.logger ?? consoleLogger;
    this.getWsPortInfo = options.getWsPortInfo ?? null;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    this.registerHandlers();
    // Prune expired ephemeral aliases on startup
    this.db.pruneExpiredAliases();
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
    const self = this;

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

        self.inflightCount++;
        onActivity();

        let request: IpcRequest;
        try {
          request = await req.json();
        } catch {
          onRequestComplete();
          self.inflightCount--;
          self.checkDrain();
          const error: IpcResponse = {
            id: "unknown",
            error: { code: IPC_ERROR.PARSE_ERROR, message: "Invalid JSON" },
          };
          return Response.json(error, { status: 400 });
        }

        // Reject new requests while draining (except the shutdown request itself already dispatched)
        if (self.draining && request.method !== "shutdown") {
          onRequestComplete();
          self.inflightCount--;
          self.checkDrain();
          const error: IpcResponse = {
            id: request.id,
            error: { code: IPC_ERROR.INTERNAL_ERROR, message: "Server is shutting down" },
          };
          return Response.json(error, { status: 503 });
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
          self.inflightCount--;
          self.checkDrain();
        }
      },
    });

    // Restrict socket to owner-only access (0600)
    hardenFile(socketPath);

    this.logger.info(`[ipc] Listening on ${socketPath}`);
  }

  /** Stop listening and clean up socket */
  stop(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.server?.stop(true);
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  /** If draining and no requests in flight, trigger shutdown on next tick (lets Bun flush responses) */
  private checkDrain(): void {
    if (this.draining && this.inflightCount === 0 && !this.shutdownScheduled) {
      this.shutdownScheduled = true;
      if (this.drainTimer) {
        clearTimeout(this.drainTimer);
        this.drainTimer = null;
      }
      // Defer to next event-loop turn so Bun can finish writing the HTTP response
      setTimeout(() => this.onShutdown(), 0);
    }
  }

  /** Start a drain timeout — force shutdown after drainTimeoutMs even if requests are stuck */
  private startDrainTimeout(): void {
    this.drainTimer = setTimeout(() => {
      if (!this.shutdownScheduled) {
        this.logger.warn(
          `[ipc] Drain timeout (${this.drainTimeoutMs}ms) — forcing shutdown with ${this.inflightCount} request(s) still in-flight`,
        );
        this.shutdownScheduled = true;
        this.onShutdown();
      }
    }, this.drainTimeoutMs);
  }

  // -- Dispatch --

  private async dispatch(request: IpcRequest): Promise<unknown> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      throw Object.assign(new Error(`Unknown method: ${request.method}`), {
        code: IPC_ERROR.METHOD_NOT_FOUND,
      });
    }

    // Create a per-request span (child of caller's traceparent, or root)
    const span = startSpan(`ipc.${request.method}`, {
      parentTraceparent: request.traceparent,
      onFallback: () => metrics.counter("mcpd_trace_fallback_root_total").inc(),
    });
    span.setAttribute("ipc.method", request.method);
    const ctx: RequestContext = { span };

    const labels = { method: request.method };
    metrics.counter("mcpd_ipc_requests_total", labels).inc();
    const stopTimer = metrics.histogram("mcpd_ipc_request_duration_ms", labels).startTimer();

    try {
      const result = await handler(request.params, ctx);
      span.setStatus("OK");
      return result;
    } catch (err) {
      span.setStatus("ERROR");
      span.setAttribute("error.message", err instanceof Error ? err.message : String(err));
      metrics.counter("mcpd_ipc_errors_total", labels).inc();
      throw err;
    } finally {
      stopTimer();
      try {
        this.db.recordSpan(span.end(), this.daemonId);
      } catch (e) {
        this.logger.error("[ipc] Failed to record span:", e);
      }
    }
  }

  // -- Handler registration --

  private registerHandlers(): void {
    this.handlers.set("ping", async (_params, _ctx) => ({
      pong: true,
      time: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
    }));

    this.handlers.set("status", async (_params, _ctx) => {
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

      const wsPortInfo = this.getWsPortInfo?.();
      const hasMismatch = wsPortInfo != null && wsPortInfo.actual != null && wsPortInfo.actual !== wsPortInfo.expected;
      const wsPortHolder = hasMismatch ? await getPortHolder(wsPortInfo.expected) : null;
      this.pruneStaleServeInstances();
      return {
        pid: process.pid,
        uptime: process.uptime(),
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: BUILD_VERSION,
        servers,
        dbPath: options.DB_PATH,
        usageStats,
        wsPort: wsPortInfo?.actual ?? null,
        wsPortExpected: wsPortInfo?.expected,
        wsPortHolder,
        serveInstances: [...this.serveInstances.values()],
      };
    });

    this.handlers.set("listServers", async (_params, _ctx) => this.pool.listServers());

    this.handlers.set("listTools", async (params, _ctx) => {
      const { server } = ListToolsParamsSchema.parse(params ?? {});
      return this.pool.listTools(server);
    });

    this.handlers.set("getToolInfo", async (params, _ctx) => {
      const { server, tool } = GetToolInfoParamsSchema.parse(params);
      return this.pool.getToolInfo(server, tool);
    });

    this.handlers.set("grepTools", async (params, _ctx) => {
      const { pattern } = GrepToolsParamsSchema.parse(params);
      return this.pool.grepTools(pattern);
    });

    this.handlers.set("callTool", async (params, ctx) => {
      const { server, tool, arguments: args, timeoutMs } = CallToolParamsSchema.parse(params);
      const toolSpan = ctx.span.child(`tool.${server}.${tool}`);
      toolSpan.setAttribute("tool.server", server);
      toolSpan.setAttribute("tool.name", tool);
      const toolLabels = { server, tool };
      try {
        const result = await this.pool.callTool(server, tool, args, timeoutMs);
        toolSpan.setStatus("OK");
        const finished = toolSpan.end();
        // Dual-write: usage_stats (Phase 1 compat) + spans table
        this.db.recordUsage(server, tool, finished.durationMs, true, undefined, {
          daemonId: this.daemonId,
          traceId: finished.traceId,
          parentId: finished.parentSpanId,
        });
        this.db.recordSpan(finished, this.daemonId);
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(finished.durationMs);
        return result;
      } catch (err) {
        toolSpan.setStatus("ERROR");
        toolSpan.setAttribute("error.message", err instanceof Error ? err.message : String(err));
        const finished = toolSpan.end();
        this.db.recordUsage(
          server,
          tool,
          finished.durationMs,
          false,
          err instanceof Error ? err.message : String(err),
          { daemonId: this.daemonId, traceId: finished.traceId, parentId: finished.parentSpanId },
        );
        this.db.recordSpan(finished, this.daemonId);
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.counter("mcpd_tool_errors_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(finished.durationMs);
        throw err;
      }
    });

    this.handlers.set("triggerAuth", async (params, _ctx) => {
      const { server } = TriggerAuthParamsSchema.parse(params);
      const serverUrl = this.pool.getServerUrl(server);

      // Non-remote server — check for `auth` tool convention
      if (!serverUrl) {
        let tools: ToolInfo[];
        try {
          tools = await this.pool.listTools(server);
        } catch {
          tools = [];
        }
        const hasAuthTool = tools.some((t) => t.name === "auth");
        if (!hasAuthTool) {
          throw Object.assign(
            new Error(`Server "${server}" not found or does not support auth (no OAuth endpoint and no "auth" tool)`),
            { code: IPC_ERROR.SERVER_NOT_FOUND },
          );
        }

        const result = (await this.pool.callTool(server, "auth", {})) as {
          content?: Array<{ type?: string; text?: string }>;
          isError?: boolean;
        };
        const text =
          result.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") ?? "";
        if (result.isError) {
          throw Object.assign(new Error(text || "auth tool returned an error"), {
            code: IPC_ERROR.INTERNAL_ERROR,
          });
        }
        return { ok: true, message: text || "Authenticated via auth tool" };
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

    this.handlers.set("authStatus", async (params, _ctx) => {
      const { server } = AuthStatusParamsSchema.parse(params ?? {});
      const allServers = this.pool.listServers();
      const filtered = server ? allServers.filter((s) => s.name === server) : allServers;

      if (server && filtered.length === 0) {
        throw Object.assign(new Error(`Server "${server}" not found`), { code: IPC_ERROR.SERVER_NOT_FOUND });
      }

      const poolDb = this.pool.getDb();
      const results: ServerAuthStatus[] = [];

      for (const srv of filtered) {
        const serverUrl = this.pool.getServerUrl(srv.name);
        let authSupport: ServerAuthStatus["authSupport"] = "none";
        let status: ServerAuthStatus["status"] = "unknown";
        let expiresAt: number | undefined;

        if (serverUrl) {
          // Remote server — check for OAuth tokens via provider (includes keychain fallback)
          authSupport = "oauth";
          if (poolDb) {
            const serverConfig = this.pool.getServerConfig(srv.name);
            const provider = new McpOAuthProvider(srv.name, serverUrl, poolDb, {
              clientId: serverConfig?.clientId,
              clientSecret: serverConfig?.clientSecret,
            });
            const tokens = await provider.tokens();
            if (tokens) {
              // Check raw expires_at from DB for accurate expiry detection
              const rawExpiry = poolDb.getTokenExpiry(srv.name);
              if (rawExpiry !== null && rawExpiry <= Date.now()) {
                status = "expired";
                expiresAt = rawExpiry;
              } else {
                status = "authenticated";
                if (rawExpiry !== null) {
                  expiresAt = rawExpiry;
                } else if (tokens.expires_in !== undefined && tokens.expires_in > 0) {
                  // Keychain token with expiry info
                  expiresAt = Date.now() + tokens.expires_in * 1000;
                }
              }
            } else {
              status = "not_authenticated";
            }
          }
        } else if (srv.transport !== "virtual") {
          // Stdio server — only check cached tools, never spawn the process
          const cachedTools = this.pool.getCachedTools(srv.name);
          if (cachedTools?.some((t) => t.name === "auth")) {
            authSupport = "auth_tool";
            status = "unknown"; // can't check without calling it
          }
        }

        results.push({
          server: srv.name,
          transport: srv.transport,
          authSupport,
          status,
          ...(expiresAt !== undefined && { expiresAt }),
        });
      }

      return { servers: results };
    });

    this.handlers.set("restartServer", async (params, _ctx) => {
      const { server } = RestartServerParamsSchema.parse(params ?? {});
      await this.pool.restart(server);
      return { ok: true };
    });

    this.handlers.set("getConfig", async (_params, _ctx) => {
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

    this.handlers.set("listAliases", async (_params, _ctx) => {
      return this.db.listAliases();
    });

    this.handlers.set("getAlias", async (params, _ctx) => {
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

    this.handlers.set("saveAlias", async (params, _ctx) => {
      const { name, script, description, expiresAt } = SaveAliasParamsSchema.parse(params);
      const filePath = safeAliasPath(name);
      mkdirSync(options.ALIASES_DIR, { recursive: true });

      // Guard: refuse to overwrite a permanent alias with an ephemeral one.
      // This check must happen BEFORE writeFileSync to protect the file on disk.
      if (expiresAt != null) {
        const existing = this.db.getAlias(name);
        if (existing && existing.expiresAt === null) {
          return { ok: false, reason: "permanent_alias_exists" };
        }
      }

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
      const warnings: string[] = [];
      const validationErrors: string[] = [];

      // Bundle the alias and extract metadata
      try {
        const { js, sourceHash } = await bundleAlias(filePath);

        if (isStructured) {
          if (!this.aliasServer) throw new Error("Alias server not initialized");
          const validation = await this.aliasServer.validateInSubprocess(js);
          if (!validation.valid) {
            validationErrors.push(...validation.errors);
          }
          if (validation.warnings.length > 0) {
            warnings.push(...validation.warnings);
          }
          this.db.saveAlias(
            name,
            filePath,
            validation.description || description,
            aliasType,
            validation.inputSchema ? JSON.stringify(validation.inputSchema) : undefined,
            validation.outputSchema ? JSON.stringify(validation.outputSchema) : undefined,
            js,
            sourceHash,
            expiresAt,
          );
        } else {
          this.db.saveAlias(name, filePath, description, aliasType, undefined, undefined, js, sourceHash, expiresAt);
        }
      } catch (err) {
        // Bundle/extraction failed — save without bundle
        validationErrors.push(`Bundle failed: ${err instanceof Error ? err.message : String(err)}`);
        this.db.saveAlias(
          name,
          filePath,
          description,
          aliasType,
          undefined,
          undefined,
          undefined,
          undefined,
          expiresAt,
        );
      }

      // Refresh virtual alias server so new tool is immediately visible
      await this.aliasServer?.refresh();
      const result: { ok: true; filePath: string; warnings?: string[]; validationErrors?: string[] } = {
        ok: true,
        filePath,
      };
      if (warnings.length > 0) result.warnings = warnings;
      if (validationErrors.length > 0) result.validationErrors = validationErrors;
      return result;
    });

    this.handlers.set("deleteAlias", async (params, _ctx) => {
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

    this.handlers.set("touchAlias", async (params, _ctx) => {
      const { name, expiresAt } = TouchAliasParamsSchema.parse(params);
      this.db.touchAliasExpiry(name, expiresAt);
      return { ok: true };
    });

    this.handlers.set("recordAliasRun", async (params, _ctx) => {
      const { name } = RecordAliasRunParamsSchema.parse(params);
      const runCount = this.db.recordAliasRun(name);
      return { ok: true, runCount };
    });

    this.handlers.set("checkAlias", async (params, _ctx) => {
      const { name } = CheckAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (!alias) {
        return { valid: false, aliasType: "freeform", errors: [`Alias "${name}" not found`], warnings: [] };
      }

      if (alias.aliasType !== "defineAlias") {
        // Freeform aliases — try bundling to check for syntax errors
        try {
          await bundleAlias(alias.filePath);
          return { valid: true, aliasType: "freeform", errors: [], warnings: [] };
        } catch (err) {
          return {
            valid: false,
            aliasType: "freeform",
            errors: [`Bundle failed: ${err instanceof Error ? err.message : String(err)}`],
            warnings: [],
          };
        }
      }

      // defineAlias — full validation
      try {
        const { js } = await bundleAlias(alias.filePath);
        if (!this.aliasServer) throw new Error("Alias server not initialized");
        return await this.aliasServer.validateInSubprocess(js);
      } catch (err) {
        return {
          valid: false,
          aliasType: "defineAlias",
          errors: [`Validation failed: ${err instanceof Error ? err.message : String(err)}`],
          warnings: [],
        };
      }
    });

    this.handlers.set("getLogs", async (params, _ctx) => {
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

    this.handlers.set("getDaemonLogs", async (params, _ctx) => {
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

    this.handlers.set("sendMail", async (params, _ctx) => {
      const { sender, recipient, subject, body, replyTo } = SendMailParamsSchema.parse(params);
      const id = this.db.insertMail(sender, recipient, subject, body, replyTo);
      return { id };
    });

    this.handlers.set("readMail", async (params, _ctx) => {
      const { recipient, unreadOnly, limit } = ReadMailParamsSchema.parse(params ?? {});
      const messages = this.db.readMail(recipient, unreadOnly, limit);
      return { messages };
    });

    this.handlers.set("waitForMail", async (params, _ctx) => {
      const { recipient, timeout } = WaitForMailParamsSchema.parse(params ?? {});
      // Server-side timeout capped at 30s to stay under IPC client's 60s timeout
      const maxWait = Math.min((timeout ?? 30) * 1000, 30_000);
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        if (this.draining) return { message: null };
        const msg = this.db.getNextUnread(recipient);
        if (msg) {
          this.db.markMailRead(msg.id);
          return { message: msg };
        }
        await Bun.sleep(500);
      }
      return { message: null };
    });

    this.handlers.set("replyToMail", async (params, _ctx) => {
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

    this.handlers.set("markRead", async (params, _ctx) => {
      const { id } = MarkReadParamsSchema.parse(params);
      this.db.markMailRead(id);
      return {};
    });

    this.handlers.set("reloadConfig", async (_params, _ctx) => {
      if (!this.onReloadConfig) {
        throw Object.assign(new Error("Config reload not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }
      await this.onReloadConfig();
      return { ok: true };
    });

    this.handlers.set("getMetrics", async (_params, _ctx) => {
      return { ...metrics.toJSON(), daemonId: this.daemonId, startedAt: this.startedAt };
    });

    // -- Span handlers --

    this.handlers.set("getSpans", async (params, _ctx) => {
      const { since, limit, unexported } = GetSpansParamsSchema.parse(params ?? {});
      return { spans: this.db.getSpans({ since, limit, unexported }) };
    });

    this.handlers.set("markSpansExported", async (params, _ctx) => {
      const { ids } = MarkSpansExportedParamsSchema.parse(params);
      const marked = this.db.markSpansExported(ids);
      return { marked };
    });

    this.handlers.set("pruneSpans", async (params, _ctx) => {
      const { before } = PruneSpansParamsSchema.parse(params ?? {});
      return { pruned: this.db.pruneSpans(before) };
    });

    // -- Serve instance tracking --

    this.handlers.set("registerServe", async (params, _ctx) => {
      const { instanceId, pid, tools } = RegisterServeParamsSchema.parse(params);
      this.serveInstances.set(instanceId, { instanceId, pid, tools, startedAt: Date.now() });
      return { ok: true as const };
    });

    this.handlers.set("unregisterServe", async (params, _ctx) => {
      const { instanceId } = UnregisterServeParamsSchema.parse(params);
      this.serveInstances.delete(instanceId);
      return { ok: true as const };
    });

    this.handlers.set("listServeInstances", async (_params, _ctx) => {
      this.pruneStaleServeInstances();
      return [...this.serveInstances.values()];
    });

    this.handlers.set("shutdown", async (params, _ctx) => {
      const { force } = ShutdownParamsSchema.parse(params ?? {});
      // Check force BEFORE querying DB — --force is the escape hatch when DB is degraded
      if (!force) {
        const activeSessions = this.db.listSessions(true);
        if (activeSessions.length > 0) {
          return {
            ok: false,
            activeSessions: activeSessions.length,
            message: `${activeSessions.length} active session(s). Use --force to shut down anyway.`,
          };
        }
      }
      // Enter drain mode — onShutdown fires after all in-flight responses are sent
      this.draining = true;
      this.startDrainTimeout();
      return { ok: true };
    });
  }

  /** Remove serve instances whose PID is no longer alive. */
  private pruneStaleServeInstances(): void {
    for (const [id, info] of this.serveInstances) {
      try {
        process.kill(info.pid, 0);
      } catch {
        this.serveInstances.delete(id);
      }
    }
  }
}

// -- Helpers --

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
