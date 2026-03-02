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

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  MCP_CLI_DIR,
  PID_PATH,
  SOCKET_PATH,
} from "@mcp-cli/core";
import { loadConfig, configHash } from "./config/loader.js";
import { ServerPool } from "./server-pool.js";
import { IpcServer } from "./ipc-server.js";

async function main(): Promise<void> {
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
  };
  writeFileSync(PID_PATH, JSON.stringify(pidData));

  // Create server pool
  const pool = new ServerPool(config);

  // Idle timeout management
  const idleTimeoutMs = Number(process.env.MCP_DAEMON_TIMEOUT) || DAEMON_IDLE_TIMEOUT_MS;
  let idleTimer: Timer | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error("[mcpd] Idle timeout reached, shutting down");
      shutdown();
    }, idleTimeoutMs);
  }

  // Start IPC server
  const ipcServer = new IpcServer(pool, { onActivity: resetIdleTimer });
  ipcServer.start();

  // Start idle timer
  resetIdleTimer();

  // Signal readiness to parent
  console.log(DAEMON_READY_SIGNAL);

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    console.error("[mcpd] Shutting down...");
    ipcServer.stop();
    await pool.closeAll();
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
