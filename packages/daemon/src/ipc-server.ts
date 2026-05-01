/**
 * HTTP-over-Unix-socket IPC server.
 *
 * Listens on ~/.mcp-cli/mcpd.sock for JSON requests from the `mcx` CLI.
 * Handler logic lives in per-domain modules under ./handlers/.
 */

import { unlinkSync } from "node:fs";
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
} from "@mcp-cli/core";
import {
  BUILD_VERSION,
  GetDaemonLogsParamsSchema,
  GetLogsParamsSchema,
  IPC_ERROR,
  PROTOCOL_VERSION,
  ShutdownParamsSchema,
  consoleLogger,
  hardenFile,
  loadManifest,
  options,
  startSpan,
} from "@mcp-cli/core";
import { z } from "zod/v4";
import type { AliasServer } from "./alias-server";
import { getDaemonLogLines } from "./daemon-log";
import type { StateDb } from "./db/state";
import { WorkItemDb } from "./db/work-items";
import type { EventBus } from "./event-bus";
import { EventStreamServer } from "./event-stream";
import type { RequestContext, RequestHandler } from "./handler-types";
import { AliasHandlers } from "./handlers/alias";
import { AuthHandlers } from "./handlers/auth";
import { BudgetHandlers } from "./handlers/budget";
import { ConfigHandlers } from "./handlers/config";
import { EventHandlers } from "./handlers/event";
import { MailHandlers } from "./handlers/mail";
import { NoteHandlers } from "./handlers/note";
import { ServeHandlers } from "./handlers/serve";
import { TelemetryHandlers } from "./handlers/telemetry";
import { ToolHandlers } from "./handlers/tool";
import { WorkItemHandlers } from "./handlers/work-item";
import { metrics } from "./metrics";
import { getPortHolder } from "./port-holder";
import type { ServerPool } from "./server-pool";

// Re-export for backward compat with existing tests and external code.
export { buildEventFilter } from "./ipc-filter";
export type { RequestContext } from "./handler-types";

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
  private getQuotaStatus: (() => IpcMethodResult["quotaStatus"]) | null = null;
  private daemonId: string;
  private startedAt: number;
  private logger: Logger;
  private eventStream: EventStreamServer;
  private serveHandlers: ServeHandlers;

  constructor(
    private pool: ServerPool,
    private config: ResolvedConfig,
    private db: StateDb,
    aliasServer: AliasServer | null,
    opts: {
      daemonId: string;
      startedAt: number;
      onActivity: () => void;
      onRequestComplete?: () => void;
      onShutdown?: () => void;
      onReloadConfig?: () => Promise<void>;
      logger?: Logger;
      getWsPortInfo?: () => { actual: number | null; expected: number };
      drainTimeoutMs?: number;
      getQuotaStatus?: () => IpcMethodResult["quotaStatus"];
      resolveIssuePr?: (number: number) => Promise<{ prNumber: number | null }>;
      loadManifest?: (repoRoot: string) => Manifest | null;
      eventBus?: EventBus;
      onAliasChanged?: (name: string) => void;
    },
  ) {
    this.daemonId = opts.daemonId;
    this.startedAt = opts.startedAt;
    this.onActivity = opts.onActivity;
    this.onRequestComplete = opts.onRequestComplete ?? (() => {});
    this.onShutdown = opts.onShutdown ?? (() => process.exit(0));
    this.onReloadConfig = opts.onReloadConfig ?? null;
    this.logger = opts.logger ?? consoleLogger;
    this.getWsPortInfo = opts.getWsPortInfo ?? null;
    this.getQuotaStatus = opts.getQuotaStatus ?? null;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 5_000;

    const workItemDb = new WorkItemDb(this.db.getDatabase());
    const eventBus = opts.eventBus ?? null;

    this.eventStream = new EventStreamServer(eventBus, this.pool, this.logger, IpcServer.HEARTBEAT_INTERVAL_MS);
    this.serveHandlers = new ServeHandlers(this.serveInstances, this.logger);

    this.registerHandlers({
      aliasServer,
      workItemDb,
      eventBus,
      resolveIssuePr: opts.resolveIssuePr ?? null,
      loadManifestFn: opts.loadManifest ?? ((r) => loadManifest(r)?.manifest ?? null),
      onAliasChanged: opts.onAliasChanged ?? null,
    });
    this.db.pruneExpiredAliases();
  }

  /** Start listening on the Unix socket */
  start(socketPath = options.SOCKET_PATH): void {
    this.socketPath = socketPath;

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
      ...({ idleTimeout: 0 } as Record<string, unknown>),
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/metrics" && req.method === "GET") {
          return new Response(metrics.toPrometheusText(), {
            headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
          });
        }

        if (url.pathname === "/logs" && req.method === "GET") {
          return self.eventStream.handleLogsSSE(url);
        }

        if (url.pathname === "/events" && req.method === "GET") {
          return self.eventStream.handleEventsNDJSON(url);
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

    hardenFile(socketPath);
    this.logger.info(`[ipc] Listening on ${socketPath}`);
  }

  /** Stop listening and clean up socket */
  stop(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.eventStream.dispose();
    this.server?.stop(true);
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  // -- Delegation to EventStreamServer (for test compatibility) --

  pushEvent(event: Record<string, unknown>): void {
    this.eventStream.pushEvent(event);
  }

  get currentEventSeq(): number {
    return this.eventStream.currentEventSeq;
  }

  get eventSubscriberCount(): number {
    return this.eventStream.eventSubscriberCount;
  }

  /** Test-mutable: patch before construction to change heartbeat cadence. */
  static HEARTBEAT_INTERVAL_MS = 30_000;
  static get MAX_EVENT_BUS_SUBSCRIBERS() {
    return EventStreamServer.MAX_EVENT_BUS_SUBSCRIBERS;
  }
  static get LIVE_BUFFER_MAX_ENTRIES() {
    return EventStreamServer.LIVE_BUFFER_MAX_ENTRIES;
  }
  static set LIVE_BUFFER_MAX_ENTRIES(v: number) {
    EventStreamServer.LIVE_BUFFER_MAX_ENTRIES = v;
  }
  static get LIVE_BUFFER_MAX_BYTES() {
    return EventStreamServer.LIVE_BUFFER_MAX_BYTES;
  }
  static set LIVE_BUFFER_MAX_BYTES(v: number) {
    EventStreamServer.LIVE_BUFFER_MAX_BYTES = v;
  }
  static get BACKFILL_BATCH_SIZE() {
    return EventStreamServer.BACKFILL_BATCH_SIZE;
  }
  static set BACKFILL_BATCH_SIZE(v: number) {
    EventStreamServer.BACKFILL_BATCH_SIZE = v;
  }
  static get BACKFILL_YIELD_FN() {
    return EventStreamServer.BACKFILL_YIELD_FN;
  }
  static set BACKFILL_YIELD_FN(v: (() => Promise<void>) | null) {
    EventStreamServer.BACKFILL_YIELD_FN = v;
  }

  // -- Dispatch --

  private async dispatch(request: IpcRequest): Promise<unknown> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      throw Object.assign(new Error(`Unknown method: ${request.method}`), {
        code: IPC_ERROR.METHOD_NOT_FOUND,
      });
    }

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

  private checkDrain(): void {
    if (this.draining && this.inflightCount === 0 && !this.shutdownScheduled) {
      this.shutdownScheduled = true;
      if (this.drainTimer) {
        clearTimeout(this.drainTimer);
        this.drainTimer = null;
      }
      setTimeout(() => this.onShutdown(), 0);
    }
  }

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

  // -- Handler registration --

  private registerHandlers(deps: {
    aliasServer: AliasServer | null;
    workItemDb: WorkItemDb;
    eventBus: EventBus | null;
    resolveIssuePr: ((n: number) => Promise<{ prNumber: number | null }>) | null;
    loadManifestFn: ((repoRoot: string) => Manifest | null) | null;
    onAliasChanged: ((name: string) => void) | null;
  }): void {
    new AuthHandlers(this.pool, this.logger).register(this.handlers);
    new AliasHandlers(this.db, deps.aliasServer, this.logger, deps.onAliasChanged ?? undefined).register(this.handlers);
    new WorkItemHandlers(deps.workItemDb, this.db, deps.resolveIssuePr, deps.loadManifestFn, this.logger).register(
      this.handlers,
    );
    this.serveHandlers.register(this.handlers);
    new BudgetHandlers(this.db).register(this.handlers);
    new EventHandlers(deps.eventBus).register(this.handlers);
    new TelemetryHandlers(this.db).register(this.handlers);
    new ConfigHandlers(this.pool, this.config, this.onReloadConfig).register(this.handlers);
    new MailHandlers(this.db, deps.eventBus, () => this.draining).register(this.handlers);
    new NoteHandlers(this.db).register(this.handlers);
    new ToolHandlers(this.pool, this.db, deps.aliasServer, this.daemonId, this.logger).register(this.handlers);

    // -- Core infrastructure handlers --

    this.handlers.set("ping", async (_params, _ctx) => ({
      pong: true,
      time: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
    }));

    this.handlers.set("status", async (_params, _ctx) => {
      const servers = this.pool.listServers();
      const usageStats = this.db.getUsageStats();

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
      this.serveHandlers.pruneStaleInstances();
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

    this.handlers.set("getLogs", async (params, _ctx) => {
      const { server, limit, since } = GetLogsParamsSchema.parse(params);

      if (since === undefined) {
        const lines = this.pool.getStderrLines(server, limit);
        return {
          server,
          lines: lines.map((l) => ({ timestamp: l.timestamp, line: l.line })),
        };
      }

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

    this.handlers.set("shutdown", async (params, _ctx) => {
      const { force } = ShutdownParamsSchema.parse(params ?? {});
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
      this.draining = true;
      this.startDrainTimeout();
      return { ok: true };
    });
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
