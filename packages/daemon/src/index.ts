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
import { dirname, join } from "node:path";
import {
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  PROTOCOL_VERSION,
  auditRuntimePermissions,
  ensureStateDir,
  generateSpanId,
  options,
} from "@mcp-cli/core";
import { AliasServer, buildAliasToolCache } from "./alias-server";
import { ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { configHash, loadConfig } from "./config/loader";
import { ConfigWatcher } from "./config/watcher";
import { closeDaemonLogFile, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log";
import { StateDb } from "./db/state";
import { IpcServer } from "./ipc-server";
import { metrics } from "./metrics";
import { reapOrphanedSessions } from "./orphan-reaper";
import { ServerPool } from "./server-pool";

/** Remove worktrees from ended sessions that are clean and have no active session. */
export function pruneOrphanedWorktrees(db: StateDb): void {
  try {
    const activeSessions = db.listSessions(true);
    const activeWorktrees = new Set(activeSessions.filter((s) => s.worktree).map((s) => s.worktree));

    const endedSessions = db.listSessions(false);
    let pruned = 0;

    for (const session of endedSessions) {
      if (!session.worktree || !session.cwd) continue;
      if (activeWorktrees.has(session.worktree)) continue;

      const worktreePath = join(session.cwd, ".claude", "worktrees", session.worktree);
      if (!existsSync(worktreePath)) continue;

      // Check if clean
      const statusResult = Bun.spawnSync(["git", "-C", worktreePath, "status", "--porcelain"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (statusResult.exitCode !== 0 || statusResult.stdout.toString().trim() !== "") continue;

      // Capture branch before removal
      const branchResult = Bun.spawnSync(["git", "-C", worktreePath, "branch", "--show-current"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() : null;

      // Remove worktree
      const removeResult = Bun.spawnSync(["git", "-C", session.cwd, "worktree", "remove", worktreePath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (removeResult.exitCode === 0) {
        pruned++;
        console.error(`[mcpd] Pruned orphaned worktree: ${worktreePath}`);
        // Delete merged branch
        if (branch) {
          const branchDelete = Bun.spawnSync(["git", "-C", session.cwd, "branch", "-d", branch], {
            stdout: "pipe",
            stderr: "pipe",
          });
          if (branchDelete.exitCode === 0) {
            console.error(`[mcpd] Deleted branch: ${branch} (merged)`);
          }
        }
      }
    }

    if (pruned > 0) {
      console.error(`[mcpd] Pruned ${pruned} orphaned worktree${pruned === 1 ? "" : "s"}`);
    }
  } catch (err) {
    console.error(`[mcpd] Worktree prune failed: ${err}`);
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
  /** Skip worktree pruning on startup. */
  skipWorktreePrune?: boolean;
}

/**
 * Start the daemon and return a handle for lifecycle management.
 * Does not install process signal handlers or call process.exit — the caller is responsible.
 */
export async function startDaemon(opts?: StartDaemonOptions): Promise<DaemonHandle> {
  if (!opts?.skipLogSetup) {
    installDaemonLogCapture();
    installDaemonLogFile();
  }

  // Ensure state directory exists with secure permissions (0700)
  ensureStateDir();

  // Load config
  const config = await loadConfig();
  const serverNames = [...config.servers.keys()];
  console.error(`[mcpd] Loaded config: ${serverNames.length} servers (${serverNames.join(", ")})`);

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
  };
  writeFileSync(options.PID_PATH, JSON.stringify(pidData));

  // Open SQLite database
  const db = new StateDb(options.DB_PATH);
  console.error(`[mcpd] Database: ${options.DB_PATH}`);

  // Reap any claude processes orphaned by a previous unclean daemon exit
  const reaped = reapOrphanedSessions(db);
  if (reaped > 0) {
    console.error(`[mcpd] Reaped ${reaped} orphaned claude process(es) from previous run`);
  }

  // Warn if runtime state permissions have been loosened
  auditRuntimePermissions();

  // Create server pool
  const pool = new ServerPool(config, db);

  // Create virtual servers (started lazily after IPC socket is ready)
  const aliasServer = new AliasServer(db, daemonId);
  const claudeServer = new ClaudeServer(db, daemonId);

  // Register uptime and server metrics
  const uptimeGauge = metrics.gauge("mcpd_uptime_seconds");
  const serversTotal = metrics.gauge("mcpd_servers_total");
  const serversConnected = metrics.gauge("mcpd_servers_connected");
  serversTotal.set(config.servers.size);

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
        console.error(`[mcpd] Idle timeout deferred: ${inFlightCount} request(s) in flight`);
        resetIdleTimer();
        return;
      }
      if (pool.hasPendingServers()) {
        console.error("[mcpd] Idle timeout deferred: virtual server(s) still starting");
        resetIdleTimer();
        return;
      }
      if (claudeServer.hasActiveSessions()) {
        console.error("[mcpd] Idle timeout deferred: session(s) not yet bye'd");
        resetIdleTimer();
        return;
      }
      console.error("[mcpd] Idle timeout reached, shutting down");
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
      console.error(`[mcpd] Config reloaded: ${parts.join("; ")}`);
    } else {
      console.error("[mcpd] Config reloaded (no server changes)");
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
  });
  ipcServer.start();

  // Start idle timer
  resetIdleTimer();

  // Signal readiness to parent (IPC socket is open, commands can connect now)
  console.log(DAEMON_READY_SIGNAL);

  // Prune orphaned worktrees after ready signal (non-blocking)
  if (!opts?.skipWorktreePrune) {
    pruneOrphanedWorktrees(db);
  }

  // Boot virtual servers in the background — commands that need them will await
  if (!opts?.skipVirtualServers) {
    pool.registerPendingVirtualServer(
      "_aliases",
      (async () => {
        try {
          const { client, transport } = await aliasServer.start();
          const cachedTools = buildAliasToolCache(db);
          pool.registerVirtualServer("_aliases", client, transport, cachedTools);
          console.error(`[mcpd] Alias server started (${cachedTools.size} tools)`);
        } catch (err) {
          console.error(`[mcpd] Failed to start alias server: ${err}`);
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
          console.error(`[mcpd] Claude session server started (port ${claudeServer.port})`);
        } catch (err) {
          console.error(`[mcpd] Failed to start Claude session server: ${err}`);
        }

        // Re-register _claude virtual server after crash recovery
        claudeServer.onRestarted = (client, transport) => {
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer("_claude", client, transport, claudeTools);
          console.error(`[mcpd] Claude session server re-registered after crash recovery (port ${claudeServer.port})`);
        };
      })(),
    );
  }

  // Graceful shutdown — re-entrant safe
  let _isShuttingDown = false;
  async function shutdown(reason?: ShutdownReason): Promise<void> {
    if (_isShuttingDown) return;
    _isShuttingDown = true;
    console.error(`[mcpd] Shutting down${reason ? ` (${reason})` : ""}...`);
    try {
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(metricsInterval);
      watcher.stop();
      ipcServer.stop();
      // Wait for any in-progress virtual server startups before stopping them
      await pool.awaitPendingServers();
      await claudeServer.stop();
      await aliasServer.stop();
      await pool.closeAll();
      db.close();
      if (!opts?.skipLogSetup) {
        closeDaemonLogFile();
      }
    } catch (cleanupErr) {
      console.error("[mcpd] Error during shutdown cleanup:", cleanupErr);
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

// --- Entry point (only runs when executed directly, not when imported) ---

async function main(): Promise<void> {
  const handle = await startDaemon();

  process.on("SIGTERM", () => {
    handle.shutdown("SIGTERM").then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    handle.shutdown("SIGINT").then(() => process.exit(0));
  });

  process.on("uncaughtException", (err) => {
    console.error("[mcpd] Uncaught exception:", err);
    handle
      .shutdown("uncaught exception")
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });
  process.on("unhandledRejection", (rejection) => {
    console.error("[mcpd] Unhandled rejection:", rejection);
    handle
      .shutdown("unhandled rejection")
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });
}

// Only run main() when executed directly (not when imported for testing)
if (import.meta.main) {
  main().catch((err) => {
    console.error("[mcpd] Fatal:", err);
    process.exit(1);
  });
}
