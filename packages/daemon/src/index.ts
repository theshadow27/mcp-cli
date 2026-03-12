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

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@mcp-cli/core";
import {
  BUILD_VERSION,
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  DEFAULT_CLAUDE_WS_PORT,
  PROTOCOL_VERSION,
  auditRuntimePermissions,
  consoleLogger,
  ensureStateDir,
  fixCoreBare,
  generateSpanId,
  options,
  readCliConfig,
  readWorktreeConfig,
  resolveWorktreePath,
} from "@mcp-cli/core";
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
import { reapOrphanedSessions } from "./orphan-reaper";
import { ServerPool } from "./server-pool";

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

  // Reap any claude processes orphaned by a previous unclean daemon exit
  const reaped = reapOrphanedSessions(db, logger);
  if (reaped > 0) {
    logger.warn(`[mcpd] Reaped ${reaped} orphaned claude process(es) from previous run`);
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

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
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
      if (claudeServer.hasActiveSessions() || codexServer?.hasActiveSessions()) {
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
  });
  ipcServer.start();

  // Reset idle timer on Claude/Codex session worker events (db:upsert, db:state, db:cost)
  claudeServer.onActivity = () => resetIdleTimer();
  if (codexServer) {
    codexServer.onActivity = () => resetIdleTimer();
  }

  // Start idle timer
  resetIdleTimer();

  // Signal readiness to parent (IPC socket is open, commands can connect now)
  console.log(DAEMON_READY_SIGNAL);

  // Boot virtual servers in the background — commands that need them will await
  if (!opts?.skipVirtualServers) {
    pool.registerPendingVirtualServer(
      "_aliases",
      (async () => {
        try {
          const { client, transport } = await aliasServer.start();
          const cachedTools = buildAliasToolCache(db);
          pool.registerVirtualServer("_aliases", client, transport, cachedTools);
          logger.info(`[mcpd] Alias server started (${cachedTools.size} tools)`);
        } catch (err) {
          logger.error(`[mcpd] Failed to start alias server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      "_claude",
      (async () => {
        try {
          const { client: claudeClient, transport: claudeTransport } = await claudeServer.start();
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer("_claude", claudeClient, claudeTransport, claudeTools);
          logger.info(`[mcpd] Claude session server started (port ${claudeServer.port})`);
        } catch (err) {
          logger.error(`[mcpd] Failed to start Claude session server: ${err}`);
        }

        // Re-register _claude virtual server after crash recovery
        claudeServer.onRestarted = (client, transport) => {
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer("_claude", client, transport, claudeTools);
          logger.info(`[mcpd] Claude session server re-registered after crash recovery (port ${claudeServer.port})`);
        };
      })(),
    );

    if (codexServer) {
      pool.registerPendingVirtualServer(
        "_codex",
        (async () => {
          try {
            const { client: codexClient, transport: codexTransport } = await codexServer.start();
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer("_codex", codexClient, codexTransport, codexTools);
            logger.info("[mcpd] Codex session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start Codex session server: ${err}`);
          }

          codexServer.onRestarted = (client, transport) => {
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer("_codex", client, transport, codexTools);
            logger.info("[mcpd] Codex session server re-registered after crash recovery");
          };
        })(),
      );
    }

    pool.registerPendingVirtualServer(
      "_metrics",
      (async () => {
        try {
          const {
            client: metricsClient,
            transport: metricsTransport,
            tools: metricsTools,
          } = await metricsServer.start();
          pool.registerVirtualServer("_metrics", metricsClient, metricsTransport, metricsTools);
          logger.info("[mcpd] Metrics server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start metrics server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      "_mail",
      (async () => {
        try {
          const { client: mailClient, transport: mailTransport, tools: mailTools } = await mailServer.start();
          pool.registerVirtualServer("_mail", mailClient, mailTransport, mailTools);
          logger.info("[mcpd] Mail server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start mail server: ${err}`);
        }
      })(),
    );
  }

  // Graceful shutdown — re-entrant safe
  let _isShuttingDown = false;
  async function shutdown(reason?: ShutdownReason): Promise<void> {
    if (_isShuttingDown) return;
    _isShuttingDown = true;
    logger.info(`[mcpd] Shutting down${reason ? ` (${reason})` : ""}...`);
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(pruneInterval);
    clearInterval(metricsInterval);
    watcher.stop();
    ipcServer.stop();
    // Wait for any in-progress virtual server startups before stopping them
    try {
      await pool.awaitPendingServers();
    } catch (err) {
      logger.error(`[mcpd] Error awaiting pending servers: ${err}`);
    }
    // Stop each virtual server individually so one failure doesn't leak the rest
    const virtualServers: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]> =
      opts?._virtualServers ?? [
        ["_claude", claudeServer],
        ["_codex", codexServer],
        ["_aliases", aliasServer],
        ["_metrics", metricsServer],
        ["_mail", mailServer],
      ];
    for (const [name, server] of virtualServers) {
      try {
        if (server) {
          await server.stop();
          pool.unregisterVirtualServer(name);
        }
      } catch (err) {
        logger.error(`[mcpd] Error stopping ${name}: ${err}`);
        pool.unregisterVirtualServer(name);
      }
    }
    try {
      await pool.closeAll();
    } catch (err) {
      logger.error(`[mcpd] Error closing server pool: ${err}`);
    }
    try {
      db.close();
    } catch (err) {
      logger.error(`[mcpd] Error closing database: ${err}`);
    }
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
  }

  return {
    shutdown,
    get isShuttingDown() {
      return _isShuttingDown;
    },
    db,
    pool,
    ipcServer,
    watcher,
  };
}
