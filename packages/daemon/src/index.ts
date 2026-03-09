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
import { dirname } from "node:path";
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
import { ServerPool } from "./server-pool";

async function main(): Promise<void> {
  // Capture daemon logs before anything else
  installDaemonLogCapture();
  installDaemonLogFile();

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

  // Warn if runtime state permissions have been loosened
  auditRuntimePermissions();

  // Create server pool
  const pool = new ServerPool(config, db);

  // Start virtual alias server
  const aliasServer = new AliasServer(db, daemonId);
  try {
    const { client, transport } = await aliasServer.start();
    const cachedTools = buildAliasToolCache(db);
    pool.registerVirtualServer("_aliases", client, transport, cachedTools);
    console.error(`[mcpd] Alias server started (${cachedTools.size} tools)`);
  } catch (err) {
    console.error(`[mcpd] Failed to start alias server: ${err}`);
  }

  // Start virtual Claude session server
  const claudeServer = new ClaudeServer(db, daemonId);
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
      if (claudeServer.hasActiveSessions()) {
        console.error("[mcpd] Idle timeout deferred: active WebSocket session(s)");
        resetIdleTimer();
        return;
      }
      console.error("[mcpd] Idle timeout reached, shutting down");
      shutdown();
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
    onShutdown: () => shutdown(),
    onReloadConfig: () => watcher.forceReload(),
  });
  ipcServer.start();

  // Start idle timer
  resetIdleTimer();

  // Signal readiness to parent
  console.log(DAEMON_READY_SIGNAL);

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    console.error("[mcpd] Shutting down...");
    clearInterval(metricsInterval);
    watcher.stop();
    ipcServer.stop();
    await claudeServer.stop();
    await aliasServer.stop();
    await pool.closeAll();
    db.close();
    closeDaemonLogFile();
    try {
      unlinkSync(options.PID_PATH);
    } catch {
      // already gone
    }
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[mcpd] Fatal:", err);
  process.exit(1);
});
