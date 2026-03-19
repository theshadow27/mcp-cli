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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@mcp-cli/core";
import {
  ACP_SERVER_NAME,
  ALIAS_SERVER_NAME,
  BUILD_VERSION,
  CLAUDE_SERVER_NAME,
  CODEX_SERVER_NAME,
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  DEFAULT_CLAUDE_WS_PORT,
  MAIL_SERVER_NAME,
  METRICS_SERVER_NAME,
  OPENCODE_SERVER_NAME,
  PROTOCOL_VERSION,
  auditRuntimePermissions,
  consoleLogger,
  ensureStateDir,
  fixCoreBare,
  generateSpanId,
  options,
  pruneExpiredCache,
  readCliConfig,
  readWorktreeConfig,
  resolveWorktreePath,
} from "@mcp-cli/core";
import { AcpServer, buildAcpToolCache } from "./acp-server";
import { AliasServer, buildAliasToolCache } from "./alias-server";
import { ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { CodexServer, buildCodexToolCache } from "./codex-server";
import { configHash, loadConfig } from "./config/loader";
import { ConfigWatcher } from "./config/watcher";
import { closeDaemonLogFile, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log";
import { StateDb } from "./db/state";
import { IpcServer } from "./ipc-server";
import { MailServer, buildMailToolCache } from "./mail-server";
import { metrics } from "./metrics";
import { MetricsServer } from "./metrics-server";
import { OpenCodeServer, buildOpenCodeToolCache } from "./opencode-server";
import { reapOrphanedSessions } from "./orphan-reaper";
import { ServerPool } from "./server-pool";

/**
 * Kill the previous daemon process (from PID file) if it's still running.
 * Prevents duplicate daemons from sharing the Unix socket after unclean restarts.
 */
function killStaleDaemons(logger: Logger): void {
  try {
    const data = JSON.parse(readFileSync(options.PID_PATH, "utf-8"));
    const pid = typeof data.pid === "number" ? data.pid : null;
    if (pid == null || pid === process.pid) return;

    // Check if it's still alive
    process.kill(pid, 0);

    // It's alive — send SIGTERM and wait briefly for it to exit
    process.kill(pid, "SIGTERM");
    logger.warn(`[mcpd] Killed previous daemon pid=${pid}`);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        Bun.sleepSync(50);
      } catch {
        break; // process exited
      }
    }
  } catch {
    // No PID file, unreadable, or process already dead — all fine
  }
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

      // Remove worktree
      const removeResult = gitOps.removeWorktree(repoRoot, worktreePath);
      if (removeResult.exitCode === 0) {
        if (fixCoreBare(repoRoot, (cmd) => gitOps.exec(cmd))) {
          logger.warn("[mcpd] Fixed core.bare=true after worktree removal");
        }
        pruned++;
        logger.info(`[mcpd] Pruned orphaned worktree: ${worktreePath}`);
        // Delete merged branch
        if (branch) {
          const deleteResult = gitOps.deleteBranch(repoRoot, branch);
          if (deleteResult.exitCode === 0) {
            logger.info(`[mcpd] Deleted branch: ${branch} (merged)`);
          }
        }
      }
    }

    if (pruned > 0) {
      logger.info(`[mcpd] Pruned ${pruned} orphaned worktree${pruned === 1 ? "" : "s"}`);
    }
  } catch (err) {
    logger.error(`[mcpd] Worktree prune failed: ${err}`);
  }
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
  readonly isShuttingDown: boolean;
  /** Resolves when shutdown is fully complete (all resources released). */
  readonly shutdownComplete: Promise<void>;
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
  /** Logger for daemon output. Defaults to consoleLogger. */
  logger?: Logger;
  /** Override virtual servers used in the shutdown loop (test injection only). */
  _virtualServers?: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]>;
}

/**
 * Start the daemon and return a handle for lifecycle management.
 * Does not install process signal handlers or call process.exit — the caller is responsible.
 */
export async function startDaemon(opts?: StartDaemonOptions): Promise<DaemonHandle> {
  // Allow env-based override for subprocess integration tests
  const skipVirtualServers = opts?.skipVirtualServers ?? process.env.MCP_DAEMON_SKIP_VIRTUAL_SERVERS === "1";
  const logger = opts?.logger ?? consoleLogger;

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

  // Kill any stale daemon processes from previous runs. Without this, duplicate
  // daemons accumulate (e.g., after unclean restarts) and share the Unix socket,
  // causing requests to round-robin across daemons with different idle timer state.
  killStaleDaemons(logger);

  // Generate daemon instance ID for trace context (stable for daemon lifetime)
  const daemonId = generateSpanId();

  // Write PID file
  const startedAt = Date.now();
  const pidData = {
    pid: process.pid,
    daemonId,
    configHash: configHash(config),
    startedAt,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: BUILD_VERSION,
  };
  writeFileSync(options.PID_PATH, JSON.stringify(pidData));

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

  const metricsServer = new MetricsServer(metrics);

  // Register uptime and server metrics
  const uptimeGauge = metrics.gauge("mcpd_uptime_seconds");
  const serversTotal = metrics.gauge("mcpd_servers_total");
  const serversConnected = metrics.gauge("mcpd_servers_connected");
  serversTotal.set(config.servers.size);

  // Periodically prune sessions whose processes have exited (every 30s).
  // This ensures dead sessions are cleaned up promptly, not just at idle-timeout boundary.
  const pruneInterval = setInterval(() => {
    claudeServer.pruneDeadSessions();
    codexServer?.pruneDeadSessions();
    acpServer?.pruneDeadSessions();
    opencodeServer?.pruneDeadSessions();
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
      if (
        claudeServer.hasActiveSessions() ||
        codexServer?.hasActiveSessions() ||
        acpServer?.hasActiveSessions() ||
        opencodeServer?.hasActiveSessions()
      ) {
        logger.debug("[mcpd] Idle timeout deferred: session(s) not yet bye'd");
        resetIdleTimer();
        return;
      }
      logger.info("[mcpd] Idle timeout reached, shutting down");
      shutdown("idle timeout");
    }, idleTimeoutMs);
  }

  // Watch config files for hot reload
  const watcher = new ConfigWatcher(config, (event) => {
    const { added, removed, changed } = pool.updateConfig(event.config);
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
    if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
    if (parts.length) {
      logger.info(`[mcpd] Config reloaded: ${parts.join("; ")}`);
    } else {
      logger.info("[mcpd] Config reloaded (no server changes)");
    }
    // Update PID file with new hash
    const updatedPid = {
      pid: process.pid,
      daemonId,
      configHash: event.hash,
      startedAt,
      protocolVersion: PROTOCOL_VERSION,
    };
    writeFileSync(options.PID_PATH, JSON.stringify(updatedPid));
  });
  watcher.start();

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
  });
  ipcServer.start();

  // Reset idle timer on Claude/Codex/ACP session worker events (db:upsert, db:state, db:cost)
  claudeServer.onActivity = () => resetIdleTimer();
  if (codexServer) {
    codexServer.onActivity = () => resetIdleTimer();
  }
  if (acpServer) {
    acpServer.onActivity = () => resetIdleTimer();
  }
  if (opencodeServer) {
    opencodeServer.onActivity = () => resetIdleTimer();
  }

  // Start idle timer
  resetIdleTimer();
  logger.debug(
    `[mcpd] Idle timer started ${Math.round(performance.now())}ms after process start (timeout=${idleTimeoutMs}ms)`,
  );

  // Signal readiness to parent (IPC socket is open, commands can connect now)
  console.log(DAEMON_READY_SIGNAL);

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
  }

  // Graceful shutdown — re-entrant safe
  let _isShuttingDown = false;
  let _shutdownResolve: (() => void) | null = null;
  const _shutdownComplete = new Promise<void>((resolve) => {
    _shutdownResolve = resolve;
  });
  async function shutdown(reason?: ShutdownReason): Promise<void> {
    if (_isShuttingDown) return _shutdownComplete;
    _isShuttingDown = true;
    const shutdownStart = performance.now();
    logger.info(`[mcpd] Shutting down${reason ? ` (${reason})` : ""}...`);
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(pruneInterval);
    clearInterval(metricsInterval);
    watcher.stop();
    ipcServer.stop();
    // Wait for any in-progress virtual server startups before stopping them
    let phase = performance.now();
    try {
      await pool.awaitPendingServers();
    } catch (err) {
      logger.error(`[mcpd] Error awaiting pending servers: ${err}`);
    }
    logger.debug(`[mcpd] Shutdown: awaitPendingServers took ${Math.round(performance.now() - phase)}ms`);
    // Stop each virtual server individually so one failure doesn't leak the rest
    const virtualServers: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]> =
      opts?._virtualServers ?? [
        [CLAUDE_SERVER_NAME, claudeServer],
        [CODEX_SERVER_NAME, codexServer],
        [ACP_SERVER_NAME, acpServer],
        [OPENCODE_SERVER_NAME, opencodeServer],
        [ALIAS_SERVER_NAME, aliasServer],
        [METRICS_SERVER_NAME, metricsServer],
        [MAIL_SERVER_NAME, mailServer],
      ];
    phase = performance.now();
    for (const [name, server] of virtualServers) {
      const serverStart = performance.now();
      try {
        if (server) {
          await server.stop();
          pool.unregisterVirtualServer(name);
        }
      } catch (err) {
        logger.error(`[mcpd] Error stopping ${name}: ${err}`);
        pool.unregisterVirtualServer(name);
      }
      if (server) {
        logger.debug(`[mcpd] Shutdown: stop ${name} took ${Math.round(performance.now() - serverStart)}ms`);
      }
    }
    logger.debug(`[mcpd] Shutdown: all virtual servers took ${Math.round(performance.now() - phase)}ms`);
    phase = performance.now();
    try {
      await pool.closeAll();
    } catch (err) {
      logger.error(`[mcpd] Error closing server pool: ${err}`);
    }
    logger.debug(`[mcpd] Shutdown: pool.closeAll took ${Math.round(performance.now() - phase)}ms`);
    phase = performance.now();
    try {
      db.close();
    } catch (err) {
      logger.error(`[mcpd] Error closing database: ${err}`);
    }
    logger.debug(`[mcpd] Shutdown: db.close took ${Math.round(performance.now() - phase)}ms`);
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
    _shutdownResolve?.();
  }

  return {
    shutdown,
    get isShuttingDown() {
      return _isShuttingDown;
    },
    shutdownComplete: _shutdownComplete,
    db,
    pool,
    ipcServer,
    watcher,
  };
}
