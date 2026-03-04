#!/usr/bin/env bun
/**
 * mcpd — MCP CLI daemon
 *
 * Manages MCP server connections, auth tokens, and tool caching.
 * Communicates with the `mcp` CLI via Unix socket IPC.
 *
 * Lifecycle:
 * 1. Read config from Claude Code / .mcp.json / ~/.mcp-cli
 * 2. Start IPC server on Unix socket
 * 3. Signal readiness to parent process
 * 4. Handle requests, connect to servers lazily
 * 5. Shut down on idle timeout or SIGTERM
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  DB_PATH,
  MCP_CLI_DIR,
  PID_PATH,
  PROTOCOL_VERSION,
  SOCKET_PATH,
} from "@mcp-cli/core";
import { configHash, loadConfig } from "./config/loader.js";
import { ConfigWatcher } from "./config/watcher.js";
import { closeDaemonLogFile, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log.js";
import { StateDb } from "./db/state.js";
import { IpcServer } from "./ipc-server.js";
import { ServerPool } from "./server-pool.js";

async function main(): Promise<void> {
  // Capture daemon logs before anything else
  installDaemonLogCapture();
  installDaemonLogFile();

  // Ensure state directory exists
  mkdirSync(MCP_CLI_DIR, { recursive: true });

  // Load config
  const config = await loadConfig();
  const serverNames = [...config.servers.keys()];
  console.error(`[mcpd] Loaded config: ${serverNames.length} servers (${serverNames.join(", ")})`);

  // Write PID file
  const pidData = {
    pid: process.pid,
    configHash: configHash(config),
    startedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
  };
  writeFileSync(PID_PATH, JSON.stringify(pidData));

  // Open SQLite database
  const db = new StateDb(DB_PATH);
  console.error(`[mcpd] Database: ${DB_PATH}`);

  // Create server pool
  const pool = new ServerPool(config, db);

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
      console.error("[mcpd] Idle timeout reached, shutting down");
      shutdown();
    }, idleTimeoutMs);
  }

  // Start IPC server
  const ipcServer = new IpcServer(pool, config, db, {
    onActivity: () => {
      inFlightCount++;
      resetIdleTimer();
    },
    onRequestComplete: () => {
      inFlightCount = Math.max(0, inFlightCount - 1);
      resetIdleTimer();
    },
    onShutdown: () => shutdown(),
  });
  ipcServer.start();

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
      configHash: event.hash,
      startedAt: pidData.startedAt,
      protocolVersion: PROTOCOL_VERSION,
    };
    writeFileSync(PID_PATH, JSON.stringify(updatedPid));
  });
  watcher.start();

  // Start idle timer
  resetIdleTimer();

  // Signal readiness to parent
  console.log(DAEMON_READY_SIGNAL);

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    console.error("[mcpd] Shutting down...");
    watcher.stop();
    ipcServer.stop();
    await pool.closeAll();
    db.close();
    closeDaemonLogFile();
    try {
      unlinkSync(PID_PATH);
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
