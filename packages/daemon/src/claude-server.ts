import type { JsonSchema, LiveSpan, Logger, MonitorEventInput, ToolInfo, WorkItemEvent } from "@mcp-cli/core";
import {
  CHECKS_FAILED,
  CHECKS_PASSED,
  CHECKS_STARTED,
  CLAUDE_SERVER_NAME,
  PHASE_CHANGED,
  PR_CLOSED,
  PR_MERGED,
  PR_MERGE_STATE_CHANGED,
  PR_OPENED,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  formatToolSignature,
  silentLogger,
  startSpan,
} from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  AbstractWorkerServer,
  BASE_WORKER_EVENT_TYPES,
  type DbCost,
  type DbUpsertSession,
  type WorkerServerDescriptor,
} from "./abstract-worker-server";
import { CLAUDE_TOOLS } from "./claude-session/tools";
import type { StateDb } from "./db/state";
import type { MetricsCollector } from "./metrics";
import { getProcessStartTime as defaultGetProcessStartTime, findDeadPids, isOurProcess } from "./process-identity";

// ── Claude-specific worker event ──

interface MonitorEventMessage {
  type: "monitor:event";
  input: MonitorEventInput;
}

export const WORKER_EVENT_TYPES: ReadonlySet<string> = new Set([...BASE_WORKER_EVENT_TYPES, "monitor:event"]);

export function isWorkerEvent(data: unknown): data is MonitorEventMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    WORKER_EVENT_TYPES.has((data as { type: string }).type)
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

// ── Server ──

const CLAUDE_DESCRIPTOR: WorkerServerDescriptor = {
  providerName: "claude",
  displayName: "Claude",
  serverName: CLAUDE_SERVER_NAME,
  workerScript: "claude-session-worker.ts",
  metrics: {
    crashLoopStopped: "mcpd_worker_crash_loop_stopped",
    crashesTotal: "mcpd_worker_crashes_total",
    activeSessions: "mcpd_active_sessions",
    sessionsTotal: "mcpd_sessions_total",
  },
};

export class ClaudeServer extends AbstractWorkerServer {
  private wsPort: number | null = null;
  private readonly configuredWsPort?: number;
  private readonly getProcessStartTimeFn: (pid: number) => number | null;
  private readonly sessionPids = new Map<string, number>();
  private readonly sessionPidStartTimes = new Map<string, number>();
  private readonly sessionLastCost = new Map<string, number>();
  private readonly daemonSpan: LiveSpan;

  onMonitorEvent?: (input: MonitorEventInput) => void;

  get descriptor(): WorkerServerDescriptor {
    return CLAUDE_DESCRIPTOR;
  }

  constructor(
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: Logger,
    handshakeTimeoutMs = 10_000,
    configuredWsPort?: number,
    getProcessStartTimeFn: (pid: number) => number | null = defaultGetProcessStartTime,
    metricsCollector?: MetricsCollector,
  ) {
    super(db, daemonId, clientFactory, logger, handshakeTimeoutMs, metricsCollector);
    this.configuredWsPort = configuredWsPort;
    this.getProcessStartTimeFn = getProcessStartTimeFn;
    this.daemonSpan = startSpan("mcpd");
  }

  get port(): number | null {
    return this.wsPort;
  }

  private static readonly WORK_ITEM_EVENT_MAP: Record<string, string> = {
    "pr:opened": PR_OPENED,
    "pr:merged": PR_MERGED,
    "pr:closed": PR_CLOSED,
    "checks:started": CHECKS_STARTED,
    "checks:passed": CHECKS_PASSED,
    "checks:failed": CHECKS_FAILED,
    "review:approved": REVIEW_APPROVED,
    "review:changes_requested": REVIEW_CHANGES_REQUESTED,
    "phase:changed": PHASE_CHANGED,
    "pr:merge_state_changed": PR_MERGE_STATE_CHANGED,
  };

  forwardWorkItemEvent(event: WorkItemEvent): void {
    const mapped = ClaudeServer.WORK_ITEM_EVENT_MAP[event.type];
    if (mapped && this.onMonitorEvent) {
      const input: MonitorEventInput = {
        src: "daemon.work-item-poller",
        event: mapped,
        category: "work_item",
      };
      if ("prNumber" in event) input.prNumber = event.prNumber;
      if ("failedJob" in event) input.failedJob = event.failedJob;
      if ("reviewer" in event) input.reviewer = event.reviewer;
      if ("itemId" in event) input.workItemId = event.itemId;
      if ("from" in event) input.from = event.from;
      if ("to" in event) input.to = event.to;
      if ("runId" in event) input.runId = event.runId;
      if ("cascadeHead" in event) input.cascadeHead = event.cascadeHead;
      this.onMonitorEvent(input);
    }
    this.worker?.postMessage({ type: "work_item_event", event });
  }

  // ── PID-aware session pruning ──

  override pruneDeadSessions(now: number = Date.now()): void {
    const pidStartTimes = new Map<number, number>();
    const legacyPids = new Map<string, number>();

    for (const [sessionId, pid] of this.sessionPids) {
      const storedStartTime = this.sessionPidStartTimes.get(sessionId);
      if (storedStartTime != null) {
        pidStartTimes.set(pid, storedStartTime);
      } else {
        legacyPids.set(sessionId, pid);
      }
    }

    const deadPids = findDeadPids(pidStartTimes);

    for (const [sessionId, pid] of this.sessionPids) {
      if (!this.sessionPidStartTimes.has(sessionId)) continue;
      if (!deadPids.has(pid)) continue;
      this.activeSessions.delete(sessionId);
      this.sessionPids.delete(sessionId);
      this.sessionPidStartTimes.delete(sessionId);
      this.sessionAddedAt.delete(sessionId);
      this.sessionLastCost.delete(sessionId);
      this.db.endSession(sessionId);
      this.metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
      this.logger.warn(`[claude-server] Pruned dead session ${sessionId} (pid ${pid} no longer alive)`);
    }

    for (const [sessionId, pid] of legacyPids) {
      if (!isProcessAlive(pid)) {
        this.activeSessions.delete(sessionId);
        this.sessionPids.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.sessionLastCost.delete(sessionId);
        this.db.endSession(sessionId);
        this.metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        this.logger.warn(`[claude-server] Pruned dead session ${sessionId} (pid ${pid} no longer alive)`);
      }
    }

    for (const sessionId of this.activeSessions) {
      if (this.sessionPids.has(sessionId)) continue;
      const addedAt = this.sessionAddedAt.get(sessionId) ?? 0;
      if (now - addedAt > ClaudeServer.NO_PID_SESSION_TTL_MS) {
        this.activeSessions.delete(sessionId);
        this.sessionAddedAt.delete(sessionId);
        this.db.endSession(sessionId);
        this.metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);
        this.logger.warn(
          `[claude-server] Pruned pid-less zombie session ${sessionId} (exceeded ${ClaudeServer.NO_PID_SESSION_TTL_MS / 60_000}min TTL)`,
        );
      }
    }
  }

  // ── Hook overrides ──

  protected override buildInitMessage(): Record<string, unknown> {
    return {
      ...super.buildInitMessage(),
      wsPort: this.configuredWsPort,
      quiet: this.logger === silentLogger,
      traceparent: this.daemonSpan.traceparent(),
    };
  }

  protected override onWorkerReady(data: unknown): void {
    this.wsPort = (data as { port: number }).port;
  }

  protected override onPostStart(): void {
    this.restoreActiveSessions();
  }

  protected override processSessionUpsert(session: DbUpsertSession): DbUpsertSession {
    if (session.pid != null) {
      this.sessionPids.set(session.sessionId, session.pid);
      const startTime =
        session.pidStartTime !== undefined ? session.pidStartTime : this.getProcessStartTimeFn(session.pid);
      if (startTime != null) {
        this.sessionPidStartTimes.set(session.sessionId, startTime);
        return { ...session, pidStartTime: startTime };
      }
      this.logger.warn(
        `[claude-server] Could not capture pid start time for session ${session.sessionId} ` +
          `pid=${session.pid} — PID reuse protection disabled for this session`,
      );
      this.metrics.counter("mcpd_sessions_without_pid_protection").inc();
    }
    const { pidStartTime: _, ...rest } = session;
    return rest;
  }

  protected override onSessionCost(event: DbCost): void {
    const prevCost = this.sessionLastCost.get(event.sessionId) ?? 0;
    const costDelta = event.cost - prevCost;
    if (costDelta > 0) this.metrics.counter("mcpd_session_cost_usd").inc(costDelta);
    this.sessionLastCost.set(event.sessionId, event.cost);
  }

  protected override onSessionEnd(sessionId: string): void {
    this.sessionPids.delete(sessionId);
    this.sessionPidStartTimes.delete(sessionId);
    this.sessionLastCost.delete(sessionId);
  }

  protected override extraStopCleanup(): void {
    this.wsPort = null;
    this.sessionPids.clear();
    this.sessionPidStartTimes.clear();
    this.sessionLastCost.clear();
    if (this.crashTimestamps.length > 0) {
      this.logger.error(`[claude-server] Cleared ${this.crashTimestamps.length} crash timestamp(s) on stop`);
    }
  }

  protected override teardownWorkerExtra(): void {
    this.wsPort = null;
  }

  protected override onCrashDetected(): void {
    this.metrics.counter("mcpd_claude_server_crashes_total").inc();
  }

  protected override captureOrphanedSessions(): Set<string> | null {
    return this.configuredWsPort !== undefined ? null : new Set(this.activeSessions);
  }

  protected override preCrashClearState(): void {
    this.activeSessions.clear();
    this.sessionPids.clear();
    this.sessionAddedAt.clear();
    this.sessionLastCost.clear();
    this.metrics.gauge("mcpd_active_sessions").set(0);
  }

  protected override onOrphanSessionEnd(sessionId: string): void {
    this.sessionPids.delete(sessionId);
    this.sessionPidStartTimes.delete(sessionId);
    this.sessionAddedAt.delete(sessionId);
    this.sessionLastCost.delete(sessionId);
  }

  protected override crashGiveUpExtraCleanup(): void {
    this.sessionPids.clear();
    this.sessionPidStartTimes.clear();
    this.sessionLastCost.clear();
  }

  protected override isProviderEvent(data: unknown): boolean {
    return (
      typeof data === "object" && data !== null && "type" in data && (data as { type: string }).type === "monitor:event"
    );
  }

  protected override handleProviderEvent(event: unknown): void {
    this.onMonitorEvent?.((event as MonitorEventMessage).input);
  }

  // ── Session restore ──

  private restoreActiveSessions(): void {
    const rows = this.db.listSessions(true);
    if (rows.length === 0) return;

    const restorable = rows.filter((row) => {
      if (this.activeSessions.has(row.sessionId)) return false;
      if (row.state === "ended") return false;
      if (row.pid != null) {
        if (row.pidStartTime != null) {
          if (!isOurProcess(row.pid, row.pidStartTime)) {
            this.logger.warn(
              `[claude-server] Skipping restore of session ${row.sessionId} — pid ${row.pid} is dead or recycled`,
            );
            this.db.endSession(row.sessionId);
            return false;
          }
        } else if (!isProcessAlive(row.pid)) {
          this.logger.warn(
            `[claude-server] Skipping restore of session ${row.sessionId} — pid ${row.pid} is no longer alive`,
          );
          this.db.endSession(row.sessionId);
          return false;
        }
      }
      return true;
    });

    if (restorable.length === 0) return;

    const now = Date.now();
    for (const row of restorable) {
      this.activeSessions.add(row.sessionId);
      if (row.pid != null) {
        this.sessionPids.set(row.sessionId, row.pid);
        if (row.pidStartTime != null) {
          this.sessionPidStartTimes.set(row.sessionId, row.pidStartTime);
        }
      }
      this.sessionAddedAt.set(row.sessionId, now);
      this.db.updateSessionState(row.sessionId, "disconnected");
    }
    this.metrics.gauge("mcpd_active_sessions").set(this.activeSessions.size);

    this.worker?.postMessage({
      type: "restore_sessions",
      sessions: restorable.map((row) => ({
        sessionId: row.sessionId,
        name: row.name,
        pid: row.pid,
        pidStartTime: row.pidStartTime,
        state: "disconnected",
        model: row.model,
        cwd: row.cwd,
        worktree: row.worktree,
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
      })),
    });

    this.logger.info(`[claude-server] Restored ${restorable.length} session(s) from SQLite for WS reconnection`);
    this.onActivity?.();
  }
}

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
