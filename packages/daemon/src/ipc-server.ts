/**
 * HTTP-over-Unix-socket IPC server.
 *
 * Listens on ~/.mcp-cli/mcpd.sock for JSON requests from the `mcx` CLI.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  IpcError,
  IpcMethod,
  IpcMethodResult,
  IpcRequest,
  IpcResponse,
  LiveSpan,
  Logger,
  Manifest,
  ResolvedConfig,
  ServeInstanceInfo,
  ServerAuthStatus,
  ToolInfo,
  WorkItemPhase,
} from "@mcp-cli/core";
import {
  ALIAS_SERVER_NAME,
  AliasStateAllParamsSchema,
  AliasStateDeleteParamsSchema,
  AliasStateGetParamsSchema,
  AliasStateSetParamsSchema,
  AuthStatusParamsSchema,
  BUILD_VERSION,
  CallToolParamsSchema,
  CheckAliasParamsSchema,
  DeleteAliasParamsSchema,
  DeleteNoteParamsSchema,
  GetAliasParamsSchema,
  GetDaemonLogsParamsSchema,
  GetLogsParamsSchema,
  GetNoteParamsSchema,
  GetSpansParamsSchema,
  GetToolInfoParamsSchema,
  GetWorkItemParamsSchema,
  GrepToolsParamsSchema,
  IPC_ERROR,
  KillServeParamsSchema,
  ListToolsParamsSchema,
  ListWorkItemsParamsSchema,
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
  SetNoteParamsSchema,
  ShutdownParamsSchema,
  TouchAliasParamsSchema,
  TrackWorkItemParamsSchema,
  TriggerAuthParamsSchema,
  UnregisterServeParamsSchema,
  UntrackWorkItemParamsSchema,
  WaitForMailParamsSchema,
  bundleAlias,
  consoleLogger,
  hardenFile,
  isDefineAlias,
  loadManifest,
  options,
  safeAliasPath,
  startSpan,
  validateFreeformTsc,
} from "@mcp-cli/core";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod/v4";
import type { AliasServer } from "./alias-server";
import { startCallbackServer } from "./auth/callback-server";
import { DEFAULT_OAUTH_SCOPE, McpOAuthProvider } from "./auth/oauth-provider";
import { getDaemonLogLines, subscribeDaemonLogs } from "./daemon-log";
import type { StateDb } from "./db/state";
import { WorkItemDb } from "./db/work-items";
import type { EventBus } from "./event-bus";
import { publishMailReceived } from "./mail-events";
import { metrics } from "./metrics";
import { getPortHolder } from "./port-holder";
import { killPid } from "./process-util";
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

  private workItemDb: WorkItemDb;
  private serveInstances = new Map<string, ServeInstanceInfo>();
  private onReloadConfig: (() => Promise<void>) | null = null;
  private getWsPortInfo: (() => { actual: number | null; expected: number }) | null = null;
  private getQuotaStatus: (() => IpcMethodResult["quotaStatus"]) | null = null;
  private resolveIssuePr: ((number: number) => Promise<{ prNumber: number | null }>) | null = null;
  private loadManifestFn: ((repoRoot: string) => Manifest | null) | null = null;
  private aliasServer: AliasServer | null = null;
  private eventBus: EventBus | null = null;
  private daemonId: string;
  private startedAt: number;
  private logger: Logger;

  /** Event stream infrastructure */
  private eventSeq = 0;
  private eventSubscribers = new Set<(event: Record<string, unknown>) => void>();

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
      /** Returns current quota status for the quotaStatus IPC method. */
      getQuotaStatus?: () => IpcMethodResult["quotaStatus"];
      /** Resolve an issue/PR number to its associated PR number via GitHub API. */
      resolveIssuePr?: (number: number) => Promise<{ prNumber: number | null }>;
      /** Load a manifest from the given repo root; injected for testability. Defaults to core loadManifest. */
      loadManifest?: (repoRoot: string) => Manifest | null;
      /** Event bus for unified monitor stream; mail events are published here. */
      eventBus?: EventBus;
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
    this.getQuotaStatus = options.getQuotaStatus ?? null;
    this.resolveIssuePr = options.resolveIssuePr ?? null;
    this.loadManifestFn = options.loadManifest ?? ((r) => loadManifest(r)?.manifest ?? null);
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    this.eventBus = options.eventBus ?? null;
    this.workItemDb = new WorkItemDb(this.db.getDatabase());
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

        // GET /logs — SSE stream for real-time log tailing
        if (url.pathname === "/logs" && req.method === "GET") {
          return self.handleLogsSSE(url);
        }

        // GET /events — NDJSON stream for real-time event delivery
        if (url.pathname === "/events" && req.method === "GET") {
          return self.handleEventsNDJSON(url);
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

  /**
   * Fire-and-forget: resolve PR number via GitHub API and update the work item.
   * Handles UNIQUE constraint collisions by merging with an existing item that
   * already tracks the same PR number.
   */
  private resolveAndUpdateWorkItem(itemId: string, issueNumber: number): void {
    if (!this.resolveIssuePr) return;
    this.resolveIssuePr(issueNumber)
      .then((resolved) => {
        if (!resolved.prNumber) return;

        // Check for UNIQUE constraint: another item may already track this PR
        const existingByPr = this.workItemDb.getWorkItemByPr(resolved.prNumber);
        if (existingByPr && existingByPr.id !== itemId) {
          this.logger.info(
            `[mcpd] PR #${resolved.prNumber} already tracked by ${existingByPr.id}, skipping update for ${itemId}`,
          );
          return;
        }

        this.workItemDb.updateWorkItem(itemId, { prNumber: resolved.prNumber });
        this.logger.info(`[mcpd] Resolved #${issueNumber} → PR #${resolved.prNumber}`);
      })
      .catch((err) => {
        this.logger.warn(
          `[mcpd] Failed to resolve PR for #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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
      const info = await this.pool.getToolInfo(server, tool);
      const note = this.db.getNote(server, tool);
      return note ? { ...info, note } : info;
    });

    this.handlers.set("grepTools", async (params, _ctx) => {
      const { pattern } = GrepToolsParamsSchema.parse(params);
      const tools = await this.pool.grepTools(pattern);

      // Enrich matched tools with notes and check if any notes match the pattern
      const allNotes = this.db.listNotes();
      const noteMap = new Map(allNotes.map((n) => [`${n.serverName}\0${n.toolName}`, n.note]));

      // Add notes to already-matched tools
      const enriched = tools.map((t) => {
        const note = noteMap.get(`${t.server}\0${t.name}`);
        return note ? { ...t, note } : t;
      });

      // Find tools that match via note content but weren't already matched
      const matchedKeys = new Set(tools.map((t) => `${t.server}\0${t.name}`));
      const regex = new RegExp(
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, "."),
        "i",
      );
      const noteMatches = allNotes.filter(
        (n) => !matchedKeys.has(`${n.serverName}\0${n.toolName}`) && regex.test(n.note),
      );

      // For note-matched tools, fetch their full ToolInfo
      for (const n of noteMatches) {
        try {
          const info = await this.pool.getToolInfo(n.serverName, n.toolName);
          enriched.push({ ...info, note: n.note });
        } catch {
          // Tool no longer exists — skip
        }
      }

      return enriched;
    });

    this.handlers.set("callTool", async (params, ctx) => {
      const { server, tool, arguments: args, timeoutMs, callChain, cwd } = CallToolParamsSchema.parse(params);
      const toolSpan = ctx.span.child(`tool.${server}.${tool}`);
      toolSpan.setAttribute("tool.server", server);
      toolSpan.setAttribute("tool.name", tool);
      if (callChain) toolSpan.setAttribute("alias.callChainDepth", callChain.length);
      const toolLabels = { server, tool };
      try {
        // Route every _aliases call through the alias server directly so the
        // caller's cwd (for repo-root scoping) and optional callChain reach
        // the executor subprocess. The pool route has no cwd channel.
        const result =
          server === ALIAS_SERVER_NAME && this.aliasServer
            ? await this.aliasServer.callToolWithChain(tool, args, callChain ?? [], cwd, timeoutMs)
            : await this.pool.callTool(server, tool, args, timeoutMs);
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
      const { clientId, clientSecret, callbackPort, scope } = serverConfig ?? {};

      // Start callback server for OAuth redirect (use configured port if available)
      const callback = startCallbackServer(callbackPort);
      try {
        // Create provider with callback URL and config-level OAuth credentials
        const provider = new McpOAuthProvider(server, serverUrl, poolDb, {
          clientId,
          clientSecret,
          callbackPort,
          scope,
        });
        provider.setRedirectUrl(callback.url);

        // Pass configured scope to auth(), or DEFAULT_OAUTH_SCOPE as fallback.
        // The SDK's cascade (resourceMetadata.scopes_supported → clientMetadata.scope)
        // runs between these; DEFAULT_OAUTH_SCOPE kicks in when none of those exist
        // (e.g. Atlassian, which requires scope=openid email profile but publishes
        // no scopes_supported in its protected resource metadata).
        const authScope = provider.getEffectiveScope() ?? DEFAULT_OAUTH_SCOPE;

        // Run the SDK auth orchestrator
        const result = await auth(provider, { serverUrl, scope: authScope });

        if (result === "AUTHORIZED") {
          // Already authorized (tokens were valid) — restart server to reconnect
          await this.pool.restart(server);
          return { ok: true, message: "Already authorized" };
        }

        // result === "REDIRECT" — browser was opened, wait for callback
        const code = await callback.waitForCode;

        // Exchange code for tokens (scope not passed — SDK reads from clientMetadata for token exchange)
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
              scope: serverConfig?.scope,
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
      const parsed = SaveAliasParamsSchema.parse(params);
      const { name, script, description, expiresAt } = parsed;
      // If the caller did not supply `scope`, preserve the existing row's scope.
      // An explicit `null` clears scope; an explicit string sets it.
      const scopeProvided =
        typeof params === "object" && params !== null && Object.prototype.hasOwnProperty.call(params, "scope");
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

      // When caller didn't supply scope, pass scopeProvided=false so the SQL
      // UPDATE branch preserves the existing row's scope atomically (no TOCTOU).
      const scope: string | null = scopeProvided ? (parsed.scope ?? null) : null;

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
            scope ?? null,
            scopeProvided,
          );
        } else {
          this.db.saveAlias(
            name,
            filePath,
            description,
            aliasType,
            undefined,
            undefined,
            js,
            sourceHash,
            expiresAt,
            scope ?? null,
            scopeProvided,
          );
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
          scope ?? null,
          scopeProvided,
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
        } catch (err) {
          return {
            valid: false,
            aliasType: "freeform",
            errors: [`Bundle failed: ${err instanceof Error ? err.message : String(err)}`],
            warnings: [],
          };
        }

        // Run tsc --noEmit for type-level diagnostics (warnings only)
        const tsc = await validateFreeformTsc(alias.filePath);
        return { valid: true, aliasType: "freeform", errors: [], warnings: tsc.warnings };
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
      publishMailReceived(this.eventBus, { mailId: id, sender, recipient });
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
      publishMailReceived(this.eventBus, { mailId: newId, sender, recipient: original.sender });
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

    this.handlers.set("quotaStatus", async (_params, _ctx) => {
      if (!this.getQuotaStatus) {
        return {
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: null,
          sevenDayOpus: null,
          extraUsage: null,
          fetchedAt: 0,
          lastError: "Quota monitoring not available",
        } satisfies IpcMethodResult["quotaStatus"];
      }
      return this.getQuotaStatus();
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

    this.handlers.set("killServe", async (params, _ctx) => {
      const { instanceId, pid, all, staleHours } = KillServeParamsSchema.parse(params ?? {});

      if (!instanceId && pid == null && !all && staleHours == null) {
        throw Object.assign(new Error("Specify instanceId, pid, all, or staleHours"), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }

      this.pruneStaleServeInstances();

      const targets: ServeInstanceInfo[] = [];
      if (staleHours != null) {
        const cutoff = Date.now() - staleHours * 60 * 60 * 1000;
        for (const inst of this.serveInstances.values()) {
          if (inst.startedAt < cutoff) targets.push(inst);
        }
      } else if (all) {
        targets.push(...this.serveInstances.values());
      } else if (instanceId) {
        const inst = this.serveInstances.get(instanceId);
        if (!inst) {
          throw Object.assign(new Error(`Serve instance "${instanceId}" not found`), {
            code: IPC_ERROR.SERVER_NOT_FOUND,
          });
        }
        targets.push(inst);
      } else if (pid != null) {
        for (const inst of this.serveInstances.values()) {
          if (inst.pid === pid) targets.push(inst);
        }
        if (targets.length === 0) {
          throw Object.assign(new Error(`No serve instance with PID ${pid}`), {
            code: IPC_ERROR.SERVER_NOT_FOUND,
          });
        }
      }

      for (const inst of targets) {
        await killPid(inst.pid, this.logger);
        this.serveInstances.delete(inst.instanceId);
      }

      return { killed: targets.length };
    });

    // -- Note handlers --

    this.handlers.set("setNote", async (params, _ctx) => {
      const { server, tool, note } = SetNoteParamsSchema.parse(params);
      this.db.setNote(server, tool, note);
      return { ok: true as const };
    });

    this.handlers.set("getNote", async (params, _ctx) => {
      const { server, tool } = GetNoteParamsSchema.parse(params);
      const note = this.db.getNote(server, tool);
      return { note: note ?? null };
    });

    this.handlers.set("listNotes", async (_params, _ctx) => {
      return this.db.listNotes();
    });

    this.handlers.set("deleteNote", async (params, _ctx) => {
      const { server, tool } = DeleteNoteParamsSchema.parse(params);
      const deleted = this.db.deleteNote(server, tool);
      return { ok: true as const, deleted };
    });

    // -- Work item tracking --

    this.handlers.set("trackWorkItem", async (params, _ctx) => {
      const { number, branch, initialPhase, repoRoot } = TrackWorkItemParamsSchema.parse(params);

      // Validate initialPhase server-side when a manifest is available (#1351).
      // When no manifest is present (repoRoot absent or manifest missing), accept any string.
      if (initialPhase && repoRoot && this.loadManifestFn) {
        const manifest = this.loadManifestFn(repoRoot);
        if (manifest) {
          const declared = Object.keys(manifest.phases);
          if (!declared.includes(initialPhase)) {
            throw Object.assign(
              new Error(`unknown initialPhase "${initialPhase}". declared phases: ${declared.join(", ")}.`),
              { code: IPC_ERROR.INVALID_PARAMS },
            );
          }
        }
      }

      // Check if already tracked
      if (number) {
        const existing = this.workItemDb.getWorkItemByIssue(number) ?? this.workItemDb.getWorkItem(`#${number}`);
        if (existing) {
          // 🔴 Backfill: if prNumber is null, kick off background re-resolution
          if (existing.prNumber === null && this.resolveIssuePr) {
            this.resolveAndUpdateWorkItem(existing.id, number);
          }
          return existing;
        }
      } else if (branch) {
        const existing = this.workItemDb.getWorkItemByBranch(branch);
        if (existing) return existing;
      }

      // Create the item immediately (non-blocking) so the caller isn't waiting on GitHub
      const id = number ? `#${number}` : `branch:${branch}`;
      const item = this.workItemDb.createWorkItem({
        id,
        issueNumber: number ?? null,
        prNumber: null,
        branch: branch ?? null,
        ...(initialPhase ? { phase: initialPhase as WorkItemPhase } : {}),
      });

      // Fire-and-forget: resolve PR number in the background
      if (number && this.resolveIssuePr) {
        this.resolveAndUpdateWorkItem(id, number);
      }

      return item;
    });

    this.handlers.set("untrackWorkItem", async (params, _ctx) => {
      const { number, branch } = UntrackWorkItemParamsSchema.parse(params);

      if (branch) {
        const existing = this.workItemDb.getWorkItemByBranch(branch) ?? this.workItemDb.getWorkItem(`branch:${branch}`);
        if (existing) {
          this.workItemDb.deleteWorkItem(existing.id);
          return { ok: true as const, deleted: true };
        }
        return { ok: true as const, deleted: false };
      }

      // Number-based lookup (number is guaranteed non-null when branch is absent per schema refine)
      const num = number as number;
      const existing =
        this.workItemDb.getWorkItemByPr(num) ??
        this.workItemDb.getWorkItemByIssue(num) ??
        this.workItemDb.getWorkItem(`#${num}`);
      if (existing) {
        this.workItemDb.deleteWorkItem(existing.id);
        return { ok: true as const, deleted: true };
      }
      return { ok: true as const, deleted: false };
    });

    this.handlers.set("listWorkItems", async (params, _ctx) => {
      const { phase } = ListWorkItemsParamsSchema.parse(params ?? {});
      return this.workItemDb.listWorkItems(phase ? { phase } : undefined);
    });

    this.handlers.set("getWorkItem", async (params, _ctx) => {
      const { id, number, branch } = GetWorkItemParamsSchema.parse(params);
      if (id) return this.workItemDb.getWorkItem(id);
      if (number !== undefined) {
        return this.workItemDb.getWorkItemByPr(number) ?? this.workItemDb.getWorkItemByIssue(number);
      }
      if (branch) return this.workItemDb.getWorkItemByBranch(branch);
      return null;
    });

    // -- Alias state (per-work-item / per-alias scratchpad) --

    this.handlers.set("aliasStateGet", async (params, _ctx) => {
      const parsed = AliasStateGetParamsSchema.parse(params);
      const repoRoot = resolve(parsed.repoRoot);
      return { value: this.db.getAliasState(repoRoot, parsed.namespace, parsed.key) };
    });

    this.handlers.set("aliasStateSet", async (params, _ctx) => {
      const parsed = AliasStateSetParamsSchema.parse(params);
      const repoRoot = resolve(parsed.repoRoot);
      this.db.setAliasState(repoRoot, parsed.namespace, parsed.key, parsed.value);
      return { ok: true as const };
    });

    this.handlers.set("aliasStateDelete", async (params, _ctx) => {
      const parsed = AliasStateDeleteParamsSchema.parse(params);
      const repoRoot = resolve(parsed.repoRoot);
      const deleted = this.db.deleteAliasState(repoRoot, parsed.namespace, parsed.key);
      return { ok: true as const, deleted };
    });

    this.handlers.set("aliasStateAll", async (params, _ctx) => {
      const parsed = AliasStateAllParamsSchema.parse(params);
      const repoRoot = resolve(parsed.repoRoot);
      return { entries: this.db.listAliasState(repoRoot, parsed.namespace) };
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

  /**
   * Push an event to all connected NDJSON event stream subscribers.
   * Each event is assigned a monotonically increasing sequence number.
   * The envelope shape is `{ t: string, seq: number, ...payload }` —
   * callers supply the full object including `t`.
   */
  pushEvent(event: Record<string, unknown>): void {
    const seq = ++this.eventSeq;
    const envelope = { ...event, seq };
    const failed: ((event: Record<string, unknown>) => void)[] = [];
    for (const cb of this.eventSubscribers) {
      try {
        cb(envelope);
      } catch (err) {
        this.logger.warn(`[events] subscriber threw, dropping: ${err}`);
        failed.push(cb);
      }
    }
    for (const cb of failed) this.eventSubscribers.delete(cb);
  }

  /** Current event sequence number (for testing / status). */
  get currentEventSeq(): number {
    return this.eventSeq;
  }

  /** Number of active event stream subscribers (for testing). */
  get eventSubscriberCount(): number {
    return this.eventSubscribers.size;
  }

  private static readonly EVENT_RING_CAPACITY = 256;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;

  /**
   * Handle GET /events — NDJSON stream for real-time event delivery.
   *
   * Query params:
   *   since=<seq>  — replay events after this cursor from the durable log,
   *                  then seamlessly switch to live delivery (#1513)
   */
  private handleEventsNDJSON(url: URL): Response {
    const sinceParam = url.searchParams.get("since");
    const sinceSeq = sinceParam !== null ? Number(sinceParam) : null;
    const eventLog = this.eventBus?.eventLog ?? null;

    const capacity = IpcServer.EVENT_RING_CAPACITY;
    const ring: string[] = new Array(capacity);
    let writeIdx = 0;
    let dropped = 0;
    let pending = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lastWriteTime = Date.now();

    const encoder = new TextEncoder();

    // Hoisted so both start and cancel can share it
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const stream = new ReadableStream({
      start: (controller) => {
        // Track the highest seq sent so live events can skip duplicates
        // after backfill.
        let highWaterMark = 0;

        const flush = () => {
          if (!pending) return;
          pending = false;
          const count = dropped > 0 ? capacity : writeIdx;
          const start = dropped > 0 ? dropped % capacity : 0;
          for (let i = 0; i < count; i++) {
            const line = ring[(start + i) % capacity] as string;
            try {
              controller.enqueue(encoder.encode(line));
            } catch {
              cleanup();
              return;
            }
          }
          writeIdx = 0;
          dropped = 0;
        };

        const enqueue = (line: string, seq?: number) => {
          if (seq !== undefined && seq <= highWaterMark) return;
          if (seq !== undefined) highWaterMark = seq;
          if (writeIdx < capacity) {
            ring[writeIdx++] = line;
          } else {
            ring[dropped % capacity] = line;
            dropped++;
          }
          pending = true;
          lastWriteTime = Date.now();
          queueMicrotask(flush);
        };

        // Flush a "connected" line to force response headers out immediately
        controller.enqueue(encoder.encode(`${JSON.stringify({ t: "connected", seq: this.eventSeq })}\n`));
        lastWriteTime = Date.now();

        // Subscribe to live events BEFORE backfilling so nothing is missed
        // during the gap between query and subscription. Live events are
        // buffered during backfill and drained after to preserve ordering.
        let liveBuffer: Array<{ line: string; seq: number | undefined }> | null = null;
        const subscriber = (event: Record<string, unknown>) => {
          const line = `${JSON.stringify(event)}\n`;
          const seq = typeof event.seq === "number" ? event.seq : undefined;
          if (liveBuffer !== null) {
            liveBuffer.push({ line, seq });
          } else {
            enqueue(line, seq);
          }
        };

        this.eventSubscribers.add(subscriber);
        unsubscribe = () => {
          this.eventSubscribers.delete(subscriber);
        };

        // Backfill from durable log when client provides a valid cursor
        if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq >= 0 && eventLog) {
          liveBuffer = [];
          let cursor = sinceSeq;
          while (true) {
            const batch = eventLog.getSince(cursor, 1000);
            for (const event of batch) {
              const line = `${JSON.stringify(event)}\n`;
              try {
                highWaterMark = event.seq;
                controller.enqueue(encoder.encode(line));
              } catch {
                cleanup();
                return;
              }
            }
            if (batch.length < 1000) break;
            cursor = batch[batch.length - 1]?.seq ?? cursor;
          }
          // Drain buffered live events; HWM dedup in enqueue() drops overlaps.
          const buffered = liveBuffer;
          liveBuffer = null;
          for (const { line, seq } of buffered) {
            enqueue(line, seq);
          }
          lastWriteTime = Date.now();
        }

        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastWriteTime >= IpcServer.HEARTBEAT_INTERVAL_MS) {
            const hb = `${JSON.stringify({ t: "heartbeat", seq: this.eventSeq })}\n`;
            try {
              controller.enqueue(encoder.encode(hb));
              lastWriteTime = Date.now();
            } catch {
              cleanup();
            }
          }
        }, IpcServer.HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref();
      },
      cancel: cleanup,
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /**
   * Handle GET /logs — Server-Sent Events stream for real-time log tailing.
   *
   * Query params:
   *   server=<name>  — stream stderr from a specific MCP server
   *   daemon=true    — stream daemon logs
   *   lines=<n>      — number of initial backfill lines (default 50)
   *   since=<ts>     — only backfill lines after this timestamp (ms)
   */
  private handleLogsSSE(url: URL): Response {
    const serverName = url.searchParams.get("server");
    const isDaemon = url.searchParams.get("daemon") === "true";
    const lines = Number(url.searchParams.get("lines") ?? "50");
    const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;

    if (!serverName && !isDaemon) {
      return new Response("Missing ?server=<name> or ?daemon=true", { status: 400 });
    }

    let unsubscribe: (() => void) | undefined;

    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();
        const send = (entry: { timestamp: number; line: string }) => {
          try {
            const data = JSON.stringify({ timestamp: entry.timestamp, line: entry.line });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {
            // Stream closed — clean up
            unsubscribe?.();
          }
        };

        // Backfill initial lines
        if (isDaemon) {
          let backfill = getDaemonLogLines(lines);
          if (since !== undefined) {
            backfill = backfill.filter((l) => l.timestamp > since);
          }
          for (const entry of backfill) {
            send(entry);
          }
        } else if (serverName) {
          let backfill = this.pool.getStderrLines(serverName, since === undefined ? lines : undefined);
          if (since !== undefined) {
            backfill = backfill.filter((l) => l.timestamp > since);
            if (backfill.length > lines) backfill = backfill.slice(-lines);
          }
          for (const entry of backfill) {
            send(entry);
          }
        }

        // Subscribe to new lines
        if (isDaemon) {
          unsubscribe = subscribeDaemonLogs((entry) => send(entry));
        } else if (serverName) {
          unsubscribe = this.pool.subscribeStderr((server, entry) => {
            if (server !== serverName) return;
            send(entry);
          });
        }
      },
      cancel: () => {
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
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
