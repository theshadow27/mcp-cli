#!/usr/bin/env bun
/**
 * mcpd — MCP CLI daemon
 *
 * Manages MCP server connections, auth tokens, and tool caching.
 * Communicates with the `mcx` CLI via Unix socket IPC.
 *
 * Lifecycle:
 * 1. Read config from Claude Code / .mcp.json / ~/.mcp-cli
 * 2. Start IPC server on Unix socket
 * 3. Signal readiness to parent process
 * 4. Handle requests, connect to servers lazily
 * 5. Shut down on idle timeout or SIGTERM
 */

import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "@mcp-cli/core";
import {
  ACP_SERVER_NAME,
  ALIAS_SERVER_NAME,
  BUILD_VERSION,
  CLAUDE_SERVER_NAME,
  CODEX_SERVER_NAME,
  DAEMON_CONFIG_RELOADED,
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  DAEMON_RESTARTED,
  DEFAULT_CLAUDE_WS_PORT,
  MAIL_SERVER_NAME,
  METRICS_SERVER_NAME,
  MOCK_SERVER_NAME,
  OPENCODE_SERVER_NAME,
  PROTOCOL_VERSION,
  PR_REVIEW_COMMENT_POSTED,
  SITE_SERVER_NAME,
  TRACING_SERVER_NAME,
  WORK_ITEMS_SERVER_NAME,
  auditRuntimePermissions,
  consoleLogger,
  ensureStateDir,
  fixCoreBare,
  generateSpanId,
  isCoreBareSet,
  loadManifest,
  options,
  pruneExpiredCache,
  readCliConfig,
  readWorktreeConfig,
  resolveWorktreePath,
  tryFlockExclusive,
} from "@mcp-cli/core";
import { AcpServer, buildAcpToolCache } from "./acp-server";
import { AliasServer, buildAliasToolCache } from "./alias-server";
import { BudgetWatcher } from "./budget-watcher";
import { ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { CodexServer, buildCodexToolCache } from "./codex-server";
import { configHash, loadConfig } from "./config/loader";
import { ConfigWatcher } from "./config/watcher";
import { closeDaemonLogFile, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log";
import { StateDb } from "./db/state";
import { WorkItemDb } from "./db/work-items";
import { DerivedEventPublisher } from "./derived-events";
import { DEFAULT_RULES } from "./derived-rules";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import type { CiEvent } from "./github/ci-events";
import { CopilotPoller } from "./github/copilot-poller";
import { type RepoInfo, detectRepo, resolveNumber } from "./github/graphql-client";
import { resolveBranchFromPr } from "./github/resolve-branch";
import { WorkItemPoller } from "./github/work-item-poller";
import { IpcServer } from "./ipc-server";
import { MailServer, buildMailToolCache } from "./mail-server";
import { metrics } from "./metrics";
import { MetricsServer } from "./metrics-server";
import { MockServer, buildMockToolCache } from "./mock-server";
import { MonitorRuntime } from "./monitor-runtime";
import { OpenCodeServer, buildOpenCodeToolCache } from "./opencode-server";
import { reapOrphanedSessions } from "./orphan-reaper";
import { QuotaPoller } from "./quota";
import { ServerPool } from "./server-pool";
import { SessionMetricsAggregator } from "./session-metrics";
import { SiteServer, buildSiteToolCache } from "./site-server";
import { TracingServer } from "./tracing-server";
import { WorkItemsServer } from "./work-items-server";

/**
 * Acquire an exclusive flock on the PID file.
 *
 * Opens the PID file, acquires a non-blocking exclusive lock, and writes the PID data.
 * The fd is kept open for the daemon's lifetime — the kernel releases the lock
 * automatically on process death (even SIGKILL). No stale lock state.
 *
 * Returns the fd (caller must keep it open) or calls process.exit(1) if another
 * daemon holds the lock.
 */
export function acquirePidLock(logger: Logger): number {
  // Open without O_TRUNC — truncating before lock acquisition would zero out
  // a running daemon's PID file. Truncate only after the lock is held.
  const fd = openSync(options.PID_PATH, constants.O_WRONLY | constants.O_CREAT, 0o600);
  const acquired = tryFlockExclusive(fd);
  if (!acquired) {
    closeSync(fd);
    logger.error("[mcpd] Another daemon is already running (PID file locked)");
    process.exit(1);
  }
  // Now that we hold the lock, truncate to clear any previous content
  ftruncateSync(fd, 0);
  return fd;
}

/**
 * Write PID data to the already-locked PID file descriptor.
 */
function writePidData(fd: number, data: Record<string, unknown>): void {
  // Truncate before writing — if new JSON is shorter than previous content,
  // stale trailing bytes would corrupt the PID file.
  ftruncateSync(fd, 0);
  const buf = Buffer.from(JSON.stringify(data));
  writeSync(fd, buf, 0, buf.length, 0);
}

/** Git operations interface for dependency injection (testable without real git). */
export interface PruneGitOps {
  pathExists(path: string): boolean;
  status(worktreePath: string): { exitCode: number; stdout: string };
  showBranch(worktreePath: string): { exitCode: number; stdout: string };
  removeWorktree(repoRoot: string, worktreePath: string): { exitCode: number };
  deleteBranch(repoRoot: string, branch: string): { exitCode: number };
  exec(cmd: string[]): { stdout: string; exitCode: number };
}

/** Default git ops using Bun.spawnSync with cleaned environment. */
function defaultGitOps(): PruneGitOps {
  const cleanEnv = { ...process.env };
  for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX"]) {
    delete cleanEnv[k];
  }
  const gitOpts = { stdout: "pipe" as const, stderr: "pipe" as const, env: cleanEnv };
  const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, gitOpts);
    return { exitCode: r.exitCode, stdout: r.stdout.toString().trim() };
  };
  return {
    pathExists: (p) => existsSync(p),
    status: (wt) => run(["git", "-C", wt, "status", "--porcelain"]),
    showBranch: (wt) => run(["git", "-C", wt, "branch", "--show-current"]),
    removeWorktree: (root, wt) => run(["git", "-C", root, "worktree", "remove", wt]),
    deleteBranch: (root, branch) => run(["git", "-C", root, "branch", "-d", branch]),
    exec: run,
  };
}

/**
 * Preflight: scan repo roots known to the daemon and unset `core.bare=true`
 * wherever it's stuck. Catches drift from external tools (e.g. `gh pr merge
 * --delete-branch`) that flip the bit outside our worktree shim. See #1330.
 *
 * Returns the number of repos that were healed.
 */
export function sweepCoreBare(
  db: StateDb,
  logger: Logger = consoleLogger,
  gitOps: PruneGitOps = defaultGitOps(),
): number {
  let healed = 0;
  try {
    const roots = new Set<string>();
    for (const s of db.listSessions(true)) {
      if (s.repoRoot) roots.add(s.repoRoot);
      else if (s.cwd) roots.add(s.cwd);
    }
    for (const s of db.listSessions(false)) {
      if (s.repoRoot) roots.add(s.repoRoot);
      else if (s.cwd) roots.add(s.cwd);
    }
    for (const root of roots) {
      if (fixCoreBare(root, (cmd) => gitOps.exec(cmd))) {
        logger.warn(`[mcpd] Healed core.bare=true on ${root} (sweep) — see #1330`);
        metrics.counter("mcpd_core_bare_healed_total", { source: "sweep" }).inc();
        healed++;
      }
    }
  } catch (err) {
    logger.error(`[mcpd] core.bare sweep failed: ${err}`);
  }
  return healed;
}

/** Remove worktrees from ended sessions that are clean and have no active session. */
export function pruneOrphanedWorktrees(
  db: StateDb,
  logger: Logger = consoleLogger,
  gitOps: PruneGitOps = defaultGitOps(),
): void {
  try {
    const activeSessions = db.listSessions(true);
    const activeWorktrees = new Set(
      activeSessions.filter((s) => s.worktree).map((s) => `${s.repoRoot ?? s.cwd}:${s.worktree}`),
    );

    const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const endedSessions = db
      .listSessions(false)
      .filter((s) => s.endedAt && Date.now() - new Date(s.endedAt).getTime() < RETENTION_MS);
    let pruned = 0;
    const affectedRepoRoots = new Set<string>();

    for (const session of endedSessions) {
      if (!session.worktree || !session.cwd) continue;
      const repoRoot = session.repoRoot ?? session.cwd;
      if (activeWorktrees.has(`${repoRoot}:${session.worktree}`)) continue;

      const hookConfig = readWorktreeConfig(repoRoot);
      const worktreePath = resolveWorktreePath(repoRoot, session.worktree, hookConfig);
      if (!gitOps.pathExists(worktreePath)) continue;

      // Check if clean
      const statusResult = gitOps.status(worktreePath);
      if (statusResult.exitCode !== 0 || statusResult.stdout.trim() !== "") continue;

      // Capture branch before removal
      const branchResult = gitOps.showBranch(worktreePath);
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

      // Remove worktree — instrument to detect which op flips core.bare (#1330).
      const bareBeforeRemove = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
      const removeResult = gitOps.removeWorktree(repoRoot, worktreePath);
      if (removeResult.exitCode === 0) {
        const bareAfterRemove = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
        if (!bareBeforeRemove && bareAfterRemove) {
          logger.warn(
            `[mcpd] core.bare flipped to true by: git worktree remove ${worktreePath} (repo=${repoRoot}) — see #1330`,
          );
        }
        if (fixCoreBare(repoRoot, (cmd) => gitOps.exec(cmd))) {
          logger.warn("[mcpd] Fixed core.bare=true after worktree removal");
          metrics.counter("mcpd_core_bare_healed_total", { source: "worktree_remove" }).inc();
        }
        affectedRepoRoots.add(repoRoot);
        pruned++;
        logger.info(`[mcpd] Pruned orphaned worktree: ${worktreePath}`);
        // Delete merged branch — also instrumented.
        if (branch) {
          const bareBeforeBranch = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
          const deleteResult = gitOps.deleteBranch(repoRoot, branch);
          if (deleteResult.exitCode === 0) {
            const bareAfterBranch = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
            if (!bareBeforeBranch && bareAfterBranch) {
              logger.warn(
                `[mcpd] core.bare flipped to true by: git branch -d ${branch} (repo=${repoRoot}) — see #1330`,
              );
              if (fixCoreBare(repoRoot, (cmd) => gitOps.exec(cmd))) {
                metrics.counter("mcpd_core_bare_healed_total", { source: "branch_delete" }).inc();
              }
            }
            logger.info(`[mcpd] Deleted branch: ${branch} (merged)`);
          }
        }
      }
    }

    if (pruned > 0) {
      // Final guard: check core.bare after all removals complete. Individual
      // per-removal fixes can be undone by subsequent removals. #1206
      for (const root of affectedRepoRoots) {
        if (fixCoreBare(root, (cmd) => gitOps.exec(cmd))) {
          logger.warn("[mcpd] Fixed core.bare=true after batch worktree prune");
          metrics.counter("mcpd_core_bare_healed_total", { source: "worktree_remove" }).inc();
        }
      }
      logger.info(`[mcpd] Pruned ${pruned} orphaned worktree${pruned === 1 ? "" : "s"}`);
    }
  } catch (err) {
    logger.error(`[mcpd] Worktree prune failed: ${err}`);
  }
}

/** Per-phase timeout for shutdown steps (ms). Prevents any single phase from hanging the process. */
const SHUTDOWN_PHASE_TIMEOUT_MS = 5_000;

/** Race a promise against a deadline. Returns "timeout" if the deadline is reached. */
async function withPhaseTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  logger: Logger,
): Promise<T | "timeout"> {
  const result = await Promise.race([
    promise.then((v) => ({ ok: v as T })),
    Bun.sleep(ms).then(() => ({ timeout: true as const })),
  ]);
  if ("timeout" in result) {
    logger.warn(`[mcpd] Shutdown phase "${label}" timed out after ${ms}ms — skipping`);
    return "timeout";
  }
  return result.ok;
}

export type ShutdownReason =
  | "SIGTERM"
  | "SIGINT"
  | "idle timeout"
  | "IPC shutdown request"
  | "uncaught exception"
  | "unhandled rejection";

/** Handle returned by startDaemon for testing and lifecycle management. */
export interface DaemonHandle {
  shutdown(reason?: ShutdownReason): Promise<void>;
  /** Resolves when shutdown completes. Useful for tests that need to await cleanup. */
  readonly shutdownComplete: Promise<void>;
  readonly isShuttingDown: boolean;
  readonly db: StateDb;
  readonly pool: ServerPool;
  readonly ipcServer: IpcServer;
  readonly watcher: ConfigWatcher;
}

export interface StartDaemonOptions {
  /** Skip log capture and log file setup (useful for tests). */
  skipLogSetup?: boolean;
  /** Skip booting virtual servers (_aliases, _claude). */
  skipVirtualServers?: boolean;
  /** Skip printing MCPD_READY to stdout (useful for tests). */
  skipReadySignal?: boolean;
  /** Logger for daemon output. Defaults to consoleLogger. */
  logger?: Logger;
  /** Override virtual servers used in the shutdown loop (test injection only). */
  _virtualServers?: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]>;
  /** Skip flock acquisition (useful for tests that don't need singleton enforcement). */
  skipFlock?: boolean;
}

/**
 * Start the daemon and return a handle for lifecycle management.
 * Does not install process signal handlers or call process.exit — the caller is responsible.
 */
export async function startDaemon(opts?: StartDaemonOptions): Promise<DaemonHandle> {
  // Allow env-based override for subprocess integration tests
  const skipVirtualServers = opts?.skipVirtualServers ?? process.env.MCP_DAEMON_SKIP_VIRTUAL_SERVERS === "1";
  const logger = opts?.logger ?? consoleLogger;

  // Cached repo info for resolveIssuePr — detected once from daemon startup cwd
  let cachedRepo: RepoInfo | null = null;

  if (!opts?.skipLogSetup) {
    installDaemonLogCapture();
    installDaemonLogFile();
  }

  // Ensure state directory exists with secure permissions (0700)
  ensureStateDir();

  // Load config
  const config = await loadConfig();
  const serverNames = [...config.servers.keys()];
  logger.info(`[mcpd] Loaded config: ${serverNames.length} servers (${serverNames.join(", ")})`);

  // Acquire exclusive flock on PID file — kernel-enforced singleton.
  // The lock is held for the daemon's lifetime (fd stays open).
  // On process death (even SIGKILL), the kernel releases it automatically.
  let pidFd: number | null = null;
  if (!opts?.skipFlock) {
    pidFd = acquirePidLock(logger);
  }

  // Generate daemon instance ID for trace context (stable for daemon lifetime)
  const daemonId = generateSpanId();

  // Write PID file (to the locked fd, or directly if flock is skipped)
  const startedAt = Date.now();
  const pidData = {
    pid: process.pid,
    daemonId,
    configHash: configHash(config),
    startedAt,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: BUILD_VERSION,
  };
  if (pidFd !== null) {
    writePidData(pidFd, pidData);
  } else {
    writeFileSync(options.PID_PATH, JSON.stringify(pidData));
  }

  // Open SQLite database
  const db = new StateDb(options.DB_PATH);
  logger.info(`[mcpd] Database: ${options.DB_PATH}`);

  // Clean up DB records for sessions whose processes are dead.
  // Alive processes are preserved for restoreActiveSessions() to pick up.
  const cleaned = reapOrphanedSessions(db, logger);
  if (cleaned > 0) {
    logger.info(`[mcpd] Cleaned up ${cleaned} stale session(s) from previous run`);
  }

  // Prune expired alias cache entries
  const cachePruned = pruneExpiredCache();
  if (cachePruned > 0) {
    logger.info(`[mcpd] Pruned ${cachePruned} expired cache entry(ies)`);
  }

  // Warn if runtime state permissions have been loosened
  auditRuntimePermissions(logger);

  // Preflight: heal any core.bare=true drift on known repos before any
  // subsequent git op touches them. External tools like `gh pr merge
  // --delete-branch` can flip the bit outside our shim. See #1330.
  sweepCoreBare(db, logger);

  // Create server pool
  const pool = new ServerPool(config, db, undefined, logger);

  // Create virtual servers (started lazily after IPC socket is ready)
  const mailServer = new MailServer(db);
  const aliasServer = new AliasServer(db, daemonId);
  const cliConfig = readCliConfig();
  const wsPort = cliConfig.wsPort ?? DEFAULT_CLAUDE_WS_PORT;
  const claudeServer = new ClaudeServer(db, daemonId, undefined, logger, 10_000, wsPort);

  // Codex server: only created if `codex` binary is installed
  const codexInstalled = Bun.spawnSync(["which", "codex"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const codexServer = codexInstalled ? new CodexServer(db, daemonId, undefined, logger) : null;

  // ACP server: created if any ACP-compatible agent binary is found on PATH
  const acpAgentInstalled =
    Bun.spawnSync(["which", "gh"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0 ||
    Bun.spawnSync(["which", "gemini"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const acpServer = acpAgentInstalled ? new AcpServer(db, daemonId, undefined, logger) : null;

  // OpenCode server: only created if `opencode` binary is installed
  const opencodeInstalled = Bun.spawnSync(["which", "opencode"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const opencodeServer = opencodeInstalled ? new OpenCodeServer(db, daemonId, undefined, logger) : null;

  // Mock server: always available (no external binary needed)
  const mockServer = new MockServer(db, daemonId, undefined, logger);

  // Site server: always started. The worker itself is lightweight — Playwright (and its ~200MB install)
  // is only loaded via dynamic import the first time a browser-dependent tool runs. Users with no
  // browser tool invocation pay the worker startup cost but nothing more.
  const siteServer = new SiteServer(daemonId, undefined, undefined, logger);

  // Start quota poller for proactive usage monitoring
  const quotaPoller = new QuotaPoller({ logger });
  quotaPoller.start();

  const metricsServer = new MetricsServer(metrics, quotaPoller);
  const tracingServer = new TracingServer(db);

  // Work items server: constructed lazily inside registerPendingVirtualServer
  // to keep migration errors from crashing the daemon (matches _metrics/_mail pattern).
  let workItemsServer: WorkItemsServer | null = null;
  let workItemPoller: WorkItemPoller | null = null;
  let copilotPoller: CopilotPoller | null = null;
  let derivedPublisher: DerivedEventPublisher | null = null;
  let monitorRuntime: MonitorRuntime | null = null;

  // Register uptime and server metrics
  const uptimeGauge = metrics.gauge("mcpd_uptime_seconds");
  const serversTotal = metrics.gauge("mcpd_servers_total");
  const serversConnected = metrics.gauge("mcpd_servers_connected");
  serversTotal.set(config.servers.size);

  // Periodically prune sessions whose processes have exited (every 30s).
  // This ensures dead sessions are cleaned up promptly, not just at idle-timeout boundary.
  // Also sweep core.bare so external flips (e.g. from `gh pr merge`) self-heal
  // within 30s regardless of origin. See #1330.
  const pruneInterval = setInterval(() => {
    claudeServer.pruneDeadSessions();
    codexServer?.pruneDeadSessions();
    acpServer?.pruneDeadSessions();
    opencodeServer?.pruneDeadSessions();
    mockServer.pruneDeadSessions();
    sweepCoreBare(db, logger);
  }, 30_000);

  // Update uptime and server gauges periodically
  const metricsInterval = setInterval(() => {
    uptimeGauge.set(Math.round(process.uptime()));
    const servers = pool.listServers();
    serversTotal.set(servers.length);
    serversConnected.set(servers.filter((s) => s.state === "connected").length);
  }, 5_000);

  // Idle timeout management with in-flight request tracking
  const idleTimeoutMs = Number(process.env.MCP_DAEMON_TIMEOUT) || DAEMON_IDLE_TIMEOUT_MS;
  let idleTimer: Timer | null = null;
  let inFlightCount = 0;

  let lastIdleReset = Date.now();
  /** Monotonic timestamp (ms) when the current idle timer was scheduled */
  let idleTimerScheduledAt = 0;

  function resetIdleTimer(): void {
    lastIdleReset = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimerScheduledAt = performance.now();
    const scheduledAt = idleTimerScheduledAt;
    idleTimer = setTimeout(() => {
      const firedAt = performance.now();
      const actualDelayMs = Math.round(firedAt - scheduledAt);
      const driftMs = actualDelayMs - idleTimeoutMs;
      const sinceLast = Date.now() - lastIdleReset;
      logger.debug(
        `[mcpd] Idle timer fired: expected=${idleTimeoutMs}ms actual=${actualDelayMs}ms drift=${driftMs}ms (${Math.round(sinceLast / 1000)}s since last reset)`,
      );
      if (driftMs > 500) {
        logger.info(
          `[mcpd] Idle timer drift warning: ${driftMs}ms late (expected ${idleTimeoutMs}ms, actual ${actualDelayMs}ms)`,
        );
      }

      if (inFlightCount > 0) {
        logger.debug(`[mcpd] Idle timeout deferred: ${inFlightCount} request(s) in flight`);
        resetIdleTimer();
        return;
      }
      if (pool.hasPendingServers()) {
        logger.debug("[mcpd] Idle timeout deferred: virtual server(s) still starting");
        resetIdleTimer();
        return;
      }
      // Prune sessions whose processes have exited before checking
      claudeServer.pruneDeadSessions();
      codexServer?.pruneDeadSessions();
      acpServer?.pruneDeadSessions();
      opencodeServer?.pruneDeadSessions();
      mockServer.pruneDeadSessions();
      if (
        claudeServer.hasActiveSessions() ||
        codexServer?.hasActiveSessions() ||
        acpServer?.hasActiveSessions() ||
        opencodeServer?.hasActiveSessions() ||
        mockServer.hasActiveSessions()
      ) {
        logger.debug("[mcpd] Idle timeout deferred: session(s) not yet bye'd");
        resetIdleTimer();
        return;
      }
      logger.info("[mcpd] Idle timeout reached, shutting down");
      shutdown("idle timeout");
    }, idleTimeoutMs);
  }

  const eventLog = new EventLog(db.getDatabase());
  const seqBefore = eventLog.currentSeq();
  eventLog.startPruning();
  const mailEventBus = new EventBus(eventLog);
  mailServer.setEventBus(mailEventBus);

  const restartedEvent = mailEventBus.publish({
    src: "daemon",
    event: DAEMON_RESTARTED,
    category: "daemon",
    seqBefore,
    seqAfter: seqBefore + 1,
    reason: "start",
  });
  logger.info(`[mcpd] Published daemon.restarted (seqBefore=${seqBefore}, seqAfter=${restartedEvent.seqAfter})`);

  // Watch config files for hot reload
  const watcher = new ConfigWatcher(config, (event) => {
    const { added, removed, changed } = pool.updateConfig(event.config);
    const changedKeys = [...added, ...removed, ...changed];
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
    if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
    if (parts.length) {
      logger.info(`[mcpd] Config reloaded: ${parts.join("; ")}`);
    } else {
      logger.info("[mcpd] Config reloaded (no server changes)");
    }
    if (changedKeys.length > 0) {
      mailEventBus.publish({
        src: "daemon",
        event: DAEMON_CONFIG_RELOADED,
        category: "daemon",
        changedKeys,
      });
    }
    // Update PID file with new hash (use locked fd if available)
    const updatedPid = {
      pid: process.pid,
      daemonId,
      configHash: event.hash,
      startedAt,
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: BUILD_VERSION,
    };
    if (pidFd !== null) {
      writePidData(pidFd, updatedPid);
    } else {
      writeFileSync(options.PID_PATH, JSON.stringify(updatedPid));
    }
  });
  watcher.start();

  // Budget watcher: emits cost/quota threshold events (#1587)
  // mailEventBus + eventLog are already created on origin/main earlier in this function (#1586).
  const budgetWatcher = new BudgetWatcher({ bus: mailEventBus, db, quotaPoller });

  // Session metrics aggregator (#1610) — on by default, opt-out via config
  let sessionMetricsAgg: SessionMetricsAggregator | null = null;
  const cliCfg = readCliConfig();
  if (cliCfg.metrics?.session?.enabled !== false) {
    sessionMetricsAgg = new SessionMetricsAggregator({
      bus: mailEventBus,
      db: db.database,
    });
    logger.info("[mcpd] Session metrics aggregator started");
  }

  // Start IPC server
  const ipcServer = new IpcServer(pool, config, db, aliasServer, {
    daemonId,
    startedAt,
    onActivity: () => {
      inFlightCount++;
      resetIdleTimer();
    },
    onRequestComplete: () => {
      inFlightCount = Math.max(0, inFlightCount - 1);
      resetIdleTimer();
    },
    onShutdown: () => shutdown("IPC shutdown request"),
    onReloadConfig: () => watcher.forceReload(),
    logger,
    getWsPortInfo: () => ({ actual: claudeServer.port, expected: wsPort }),
    getQuotaStatus: () => {
      const status = quotaPoller.status;
      return {
        fiveHour: status?.fiveHour ?? null,
        sevenDay: status?.sevenDay ?? null,
        sevenDaySonnet: status?.sevenDaySonnet ?? null,
        sevenDayOpus: status?.sevenDayOpus ?? null,
        extraUsage: status?.extraUsage ?? null,
        fetchedAt: status?.fetchedAt ?? 0,
        lastError: quotaPoller.lastError,
      };
    },
    resolveIssuePr: async (number: number) => {
      // Cache repo detection so we don't re-run `git remote` on every track call.
      // Uses the daemon's startup cwd which is the project root at launch time.
      if (!cachedRepo) {
        cachedRepo = await detectRepo(process.cwd());
      }
      const resolved = await resolveNumber(cachedRepo, number);
      return { prNumber: resolved.prNumber };
    },
    eventBus: mailEventBus,
    onAliasChanged: (name) => {
      monitorRuntime?.restartMonitor(name).catch((err) => {
        logger.error(`[mcpd] Monitor restart for "${name}" failed: ${err}`);
      });
    },
  });
  ipcServer.start();

  // Reset idle timer on Claude/Codex/ACP session worker events (db:upsert, db:state, db:cost)
  claudeServer.onActivity = () => resetIdleTimer();
  claudeServer.onMonitorEvent = (input) => mailEventBus.publish(input);
  if (codexServer) {
    codexServer.onActivity = () => resetIdleTimer();
  }
  if (acpServer) {
    acpServer.onActivity = () => resetIdleTimer();
  }
  if (opencodeServer) {
    opencodeServer.onActivity = () => resetIdleTimer();
  }
  mockServer.onActivity = () => resetIdleTimer();
  // Site browser sessions can sit idle during interactive login — keep the daemon alive.
  siteServer.onActivity = () => resetIdleTimer();

  // Start idle timer
  resetIdleTimer();
  logger.debug(
    `[mcpd] Idle timer started ${Math.round(performance.now())}ms after process start (timeout=${idleTimeoutMs}ms)`,
  );

  // Signal readiness to parent (IPC socket is open, commands can connect now).
  // Uses console.log (stdout) because installDaemonLogCapture redirects
  // console.info/error/warn to stderr — the parent process reads stdout.
  // Tests pass skipReadySignal to suppress this output.
  if (!opts?.skipReadySignal) {
    console.log(DAEMON_READY_SIGNAL);
  }

  // Boot virtual servers in the background — commands that need them will await
  if (!skipVirtualServers) {
    pool.registerPendingVirtualServer(
      ALIAS_SERVER_NAME,
      (async () => {
        try {
          const { client, transport } = await aliasServer.start();
          const cachedTools = buildAliasToolCache(db);
          pool.registerVirtualServer(ALIAS_SERVER_NAME, client, transport, cachedTools);
          logger.info(`[mcpd] Alias server started (${cachedTools.size} tools)`);

          // Start monitor runtime for defineMonitor aliases
          monitorRuntime = new MonitorRuntime({
            bus: mailEventBus,
            logger,
            listMonitors: () => db.listAliases().filter((a) => a.aliasType === "defineMonitor"),
            getAlias: (name) => {
              const a = db.getAlias(name);
              if (!a) return undefined;
              return { ...a, aliasType: a.aliasType };
            },
          });
          await monitorRuntime.startAll();
        } catch (err) {
          logger.error(`[mcpd] Failed to start alias server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      CLAUDE_SERVER_NAME,
      (async () => {
        try {
          const { client: claudeClient, transport: claudeTransport } = await claudeServer.start();
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer(CLAUDE_SERVER_NAME, claudeClient, claudeTransport, claudeTools);
          logger.info(`[mcpd] Claude session server started (port ${claudeServer.port})`);
        } catch (err) {
          logger.error(`[mcpd] Failed to start Claude session server: ${err}`);
        }

        // Re-register _claude virtual server after crash recovery
        claudeServer.onRestarted = (client, transport) => {
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer(CLAUDE_SERVER_NAME, client, transport, claudeTools);
          logger.info(`[mcpd] Claude session server re-registered after crash recovery (port ${claudeServer.port})`);
        };
      })(),
    );

    if (codexServer) {
      pool.registerPendingVirtualServer(
        CODEX_SERVER_NAME,
        (async () => {
          try {
            const { client: codexClient, transport: codexTransport } = await codexServer.start();
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer(CODEX_SERVER_NAME, codexClient, codexTransport, codexTools);
            logger.info("[mcpd] Codex session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start Codex session server: ${err}`);
          }

          codexServer.onRestarted = (client, transport) => {
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer(CODEX_SERVER_NAME, client, transport, codexTools);
            logger.info("[mcpd] Codex session server re-registered after crash recovery");
          };
        })(),
      );
    }

    if (acpServer) {
      pool.registerPendingVirtualServer(
        ACP_SERVER_NAME,
        (async () => {
          try {
            const { client: acpClient, transport: acpTransport } = await acpServer.start();
            const acpTools = buildAcpToolCache();
            pool.registerVirtualServer(ACP_SERVER_NAME, acpClient, acpTransport, acpTools);
            logger.info("[mcpd] ACP session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start ACP session server: ${err}`);
          }

          acpServer.onRestarted = (client, transport) => {
            const acpTools = buildAcpToolCache();
            pool.registerVirtualServer(ACP_SERVER_NAME, client, transport, acpTools);
            logger.info("[mcpd] ACP session server re-registered after crash recovery");
          };
        })(),
      );
    }

    if (opencodeServer) {
      pool.registerPendingVirtualServer(
        OPENCODE_SERVER_NAME,
        (async () => {
          try {
            const { client: opencodeClient, transport: opencodeTransport } = await opencodeServer.start();
            const opencodeTools = buildOpenCodeToolCache();
            pool.registerVirtualServer(OPENCODE_SERVER_NAME, opencodeClient, opencodeTransport, opencodeTools);
            logger.info("[mcpd] OpenCode session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start OpenCode session server: ${err}`);
          }

          opencodeServer.onRestarted = (client, transport) => {
            const opencodeTools = buildOpenCodeToolCache();
            pool.registerVirtualServer(OPENCODE_SERVER_NAME, client, transport, opencodeTools);
            logger.info("[mcpd] OpenCode session server re-registered after crash recovery");
          };
        })(),
      );
    }

    pool.registerPendingVirtualServer(
      MOCK_SERVER_NAME,
      (async () => {
        try {
          const { client: mockClient, transport: mockTransport } = await mockServer.start();
          const mockTools = buildMockToolCache();
          pool.registerVirtualServer(MOCK_SERVER_NAME, mockClient, mockTransport, mockTools);
          logger.info("[mcpd] Mock session server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start mock server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      SITE_SERVER_NAME,
      (async () => {
        try {
          const { client: siteClient, transport: siteTransport } = await siteServer.start();
          const siteTools = buildSiteToolCache();
          pool.registerVirtualServer(SITE_SERVER_NAME, siteClient, siteTransport, siteTools);
          logger.info("[mcpd] Site server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start site server: ${err}`);
        }

        siteServer.onRestarted = (client, transport) => {
          const siteTools = buildSiteToolCache();
          pool.registerVirtualServer(SITE_SERVER_NAME, client, transport, siteTools);
          logger.info("[mcpd] Site server re-registered after crash recovery");
        };
        siteServer.onPermanentlyFailed = () => {
          pool.unregisterVirtualServer(SITE_SERVER_NAME);
          logger.error("[mcpd] Site server permanently failed — removed from pool; restart daemon to recover");
        };
      })(),
    );

    pool.registerPendingVirtualServer(
      METRICS_SERVER_NAME,
      (async () => {
        try {
          const {
            client: metricsClient,
            transport: metricsTransport,
            tools: metricsTools,
          } = await metricsServer.start();
          pool.registerVirtualServer(METRICS_SERVER_NAME, metricsClient, metricsTransport, metricsTools);
          logger.info("[mcpd] Metrics server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start metrics server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      TRACING_SERVER_NAME,
      (async () => {
        try {
          const {
            client: tracingClient,
            transport: tracingTransport,
            tools: tracingTools,
          } = await tracingServer.start();
          pool.registerVirtualServer(TRACING_SERVER_NAME, tracingClient, tracingTransport, tracingTools);
          logger.info("[mcpd] Tracing server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start tracing server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      MAIL_SERVER_NAME,
      (async () => {
        try {
          const { client: mailClient, transport: mailTransport, tools: mailTools } = await mailServer.start();
          pool.registerVirtualServer(MAIL_SERVER_NAME, mailClient, mailTransport, mailTools);
          logger.info("[mcpd] Mail server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start mail server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      WORK_ITEMS_SERVER_NAME,
      (async () => {
        try {
          const workItemDb = new WorkItemDb(db.database);

          // Create the poller first so we can pass pollNow to the server
          workItemPoller = new WorkItemPoller({
            db: workItemDb,
            logger,
            onEvent: (event) => claudeServer.forwardWorkItemEvent(event),
            onCiEvent: (event) => publishCiEvent(mailEventBus, event),
          });

          // Wire the alias executor's work-item resolver — resolves the caller
          // cwd's branch → tracked work item in-process, so alias subprocesses
          // don't need to phone home via IPC to answer ctx.workItem.
          aliasServer.setWorkItemResolver(async (cwd) => {
            try {
              // Read .git/HEAD directly — `git symbolic-ref --short HEAD` just
              // parses this file, and forking git blocks the event loop (up to
              // 3s on slow FS or under .git/index.lock contention). For
              // worktrees, `.git` is a file "gitdir: <path>" pointing at the
              // real git dir; follow it to find the per-worktree HEAD.
              let gitDir = `${cwd}/.git`;
              const dotGit = Bun.file(gitDir);
              if (!(await dotGit.exists())) return null;
              const dotGitStat = await dotGit.stat();
              if (dotGitStat.isFile()) {
                const gitdirLine = (await dotGit.text()).trim();
                const match = gitdirLine.match(/^gitdir:\s*(.+)$/);
                const target = match?.[1]?.trim();
                if (!target) return null;
                gitDir = target.startsWith("/") ? target : `${cwd}/${target}`;
              }
              const headFile = Bun.file(`${gitDir}/HEAD`);
              if (!(await headFile.exists())) return null;
              const headContent = (await headFile.text()).trim();
              // "ref: refs/heads/<branch>" for attached HEAD; bare SHA for detached
              const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
              const branch = refMatch?.[1]?.trim();
              if (!branch) return null;
              const item = workItemDb.getWorkItemByBranch(branch);
              if (!item) return null;
              return {
                id: item.id,
                issueNumber: item.issueNumber,
                prNumber: item.prNumber,
                branch: item.branch,
                phase: item.phase,
              };
            } catch {
              return null;
            }
          });

          workItemsServer = new WorkItemsServer(workItemDb, {
            stateDb: db,
            onTrack: () => workItemPoller?.pollNow(),
            loadManifest: (repoRoot) => {
              try {
                return loadManifest(repoRoot)?.manifest ?? null;
              } catch {
                // Malformed manifest — behave as if absent so callers don't hard-fail.
                return null;
              }
            },
            resolveBranchFromPr: async (prNumber: number) => {
              // Re-use the cached repo detected from daemon startup cwd so the
              // --repo flag is always explicit (avoids `gh pr view` resolving
              // against an ambiguous cwd). Returns null when repo detection
              // fails; caller treats that as "branch not known" and continues.
              if (!cachedRepo) {
                try {
                  cachedRepo = await detectRepo(process.cwd());
                } catch {
                  return null;
                }
              }
              return resolveBranchFromPr(prNumber, { repo: cachedRepo });
            },
            logger,
          });
          const {
            client: workItemsClient,
            transport: workItemsTransport,
            tools: workItemsTools,
          } = await workItemsServer.start();
          pool.registerVirtualServer(WORK_ITEMS_SERVER_NAME, workItemsClient, workItemsTransport, workItemsTools);
          logger.info("[mcpd] Work items server started");

          // Start the GitHub work item poller — forwards events to the claude session worker
          // so `mcx wait --any` / `--pr` / `--checks` can race work item events.
          workItemPoller.start();
          logger.info("[mcpd] Work item poller started");

          copilotPoller = new CopilotPoller({
            workItemDb,
            stateDb: db,
            logger,
            onEvent: (event) => {
              if (event.event === PR_REVIEW_COMMENT_POSTED) {
                const key = `${event.event}:${event.prNumber}:${event.author}`;
                mailEventBus.publishCoalesced(event, key, {
                  mode: "merge",
                  merge: (a, b) => {
                    const ids = [
                      ...new Set([...((a.commentIds as number[]) ?? []), ...((b.commentIds as number[]) ?? [])]),
                    ];
                    return { ...a, newCount: ids.length, commentIds: ids };
                  },
                  windowMs: 500,
                });
              } else {
                mailEventBus.publish(event);
              }
            },
          });
          copilotPoller.start();
          logger.info("[mcpd] Copilot poller started");

          // Derived event publisher: subscribes to the bus AFTER poller is up,
          // runs rules on each event, re-publishes derived events with causedBy chain.
          // Subscribe order: subscribers registered before this (SSE streams) see
          // trigger events before derived events; subscribers registered after see
          // derived events first (both carry seq for canonical ordering).
          derivedPublisher = new DerivedEventPublisher({
            bus: mailEventBus,
            rules: DEFAULT_RULES,
            workItemDb,
            db: db.database,
            eventLog,
          });
          const reconciled = derivedPublisher.reconcile();
          if (reconciled > 0) {
            logger.info(`[mcpd] Derived event reconciliation replayed ${reconciled} event(s)`);
          }
          logger.info("[mcpd] Derived event publisher started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start work items server: ${err}`);
        }
      })(),
    );
  }

  function publishCiEvent(bus: EventBus, event: CiEvent): void {
    const base = {
      src: "daemon.work-item-poller",
      event: event.type,
      category: "ci" as const,
      prNumber: event.prNumber,
      workItemId: event.workItemId,
    };
    const coalesceKey = `ci:${event.prNumber}`;

    if (event.type === "ci.started") {
      bus.publish({ ...base, checks: event.checks });
    } else if (event.type === "ci.running") {
      bus.publishCoalesced({ ...base, inProgress: event.inProgress, completed: event.completed }, coalesceKey, {
        mode: "last-wins",
        windowMs: 500,
      });
    } else {
      // ci.finished — flush pending ci.running, then publish immediately
      bus.publishCoalesced(
        { ...base, checks: event.checks, allGreen: event.allGreen, observedDurationMs: event.observedDurationMs },
        coalesceKey,
        { mode: "never" },
      );
    }
  }

  // Graceful shutdown — re-entrant safe
  let _isShuttingDown = false;
  let _resolveShutdown!: () => void;
  const _shutdownComplete = new Promise<void>((r) => {
    _resolveShutdown = r;
  });
  async function shutdown(reason?: ShutdownReason): Promise<void> {
    if (_isShuttingDown) return;
    _isShuttingDown = true;
    const shutdownStart = performance.now();
    try {
      logger.info(`[mcpd] Shutting down${reason ? ` (${reason})` : ""}...`);
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(pruneInterval);
      clearInterval(metricsInterval);
      eventLog.stopPruning();
      quotaPoller.stop();
      budgetWatcher.dispose();
      workItemPoller?.stop();
      copilotPoller?.stop();
      derivedPublisher?.dispose();
      sessionMetricsAgg?.dispose();
      if (monitorRuntime) {
        const monPhase = performance.now();
        await withPhaseTimeout(monitorRuntime.stopAll(), SHUTDOWN_PHASE_TIMEOUT_MS, "monitorRuntime.stopAll", logger);
        logger.info(`[mcpd] Shutdown: monitorRuntime.stopAll took ${Math.round(performance.now() - monPhase)}ms`);
      }
      mailEventBus.disposeCoalescer();
      try {
        watcher.stop();
      } catch (err) {
        logger.error(`[mcpd] Error stopping config watcher: ${err}`);
      }
      try {
        ipcServer.stop();
      } catch (err) {
        logger.error(`[mcpd] Error stopping IPC server: ${err}`);
      }
      // Wait for any in-progress virtual server startups before stopping them
      let phase = performance.now();
      try {
        await withPhaseTimeout(pool.awaitPendingServers(), SHUTDOWN_PHASE_TIMEOUT_MS, "awaitPendingServers", logger);
      } catch (err) {
        logger.error(`[mcpd] Error awaiting pending servers: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: awaitPendingServers took ${Math.round(performance.now() - phase)}ms`);
      // Stop each virtual server individually so one failure doesn't leak the rest
      const virtualServers: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]> =
        opts?._virtualServers ?? [
          [CLAUDE_SERVER_NAME, claudeServer],
          [CODEX_SERVER_NAME, codexServer],
          [ACP_SERVER_NAME, acpServer],
          [OPENCODE_SERVER_NAME, opencodeServer],
          [MOCK_SERVER_NAME, mockServer],
          [SITE_SERVER_NAME, siteServer],
          [ALIAS_SERVER_NAME, aliasServer],
          [METRICS_SERVER_NAME, metricsServer],
          [TRACING_SERVER_NAME, tracingServer],
          [MAIL_SERVER_NAME, mailServer],
          [WORK_ITEMS_SERVER_NAME, workItemsServer],
        ];
      phase = performance.now();
      for (const [name, server] of virtualServers) {
        const serverStart = performance.now();
        try {
          if (server) {
            const result = await withPhaseTimeout(server.stop(), SHUTDOWN_PHASE_TIMEOUT_MS, `stop ${name}`, logger);
            if (result === "timeout") {
              logger.warn(`[mcpd] Force-unregistering ${name} after stop timeout`);
            }
            pool.unregisterVirtualServer(name);
          }
        } catch (err) {
          logger.error(`[mcpd] Error stopping ${name}: ${err}`);
          pool.unregisterVirtualServer(name);
        }
        if (server) {
          logger.info(`[mcpd] Shutdown: stop ${name} took ${Math.round(performance.now() - serverStart)}ms`);
        }
      }
      logger.info(`[mcpd] Shutdown: all virtual servers took ${Math.round(performance.now() - phase)}ms`);
      phase = performance.now();
      try {
        await withPhaseTimeout(pool.closeAll(), SHUTDOWN_PHASE_TIMEOUT_MS, "pool.closeAll", logger);
      } catch (err) {
        logger.error(`[mcpd] Error closing server pool: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: pool.closeAll took ${Math.round(performance.now() - phase)}ms`);
      phase = performance.now();
      try {
        db.close();
      } catch (err) {
        logger.error(`[mcpd] Error closing database: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: db.close took ${Math.round(performance.now() - phase)}ms`);
      if (!opts?.skipLogSetup) {
        try {
          closeDaemonLogFile();
        } catch (err) {
          logger.error(`[mcpd] Error closing log file: ${err}`);
        }
      }
      try {
        unlinkSync(options.PID_PATH);
      } catch {
        // already gone
      }
      const totalShutdownMs = Math.round(performance.now() - shutdownStart);
      logger.info(`[mcpd] Shutdown complete in ${totalShutdownMs}ms`);
    } finally {
      _resolveShutdown();
    }
  }

  return {
    shutdown,
    shutdownComplete: _shutdownComplete,
    get isShuttingDown() {
      return _isShuttingDown;
    },
    db,
    pool,
    ipcServer,
    watcher,
  };
}
