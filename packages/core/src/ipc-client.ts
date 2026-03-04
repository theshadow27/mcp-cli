/**
 * IPC client — connects to mcpd daemon via HTTP-over-Unix-socket.
 *
 * Shared by both the CLI (command) and TUI (control) packages.
 * Auto-starts the daemon if not running.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAEMON_BINARY_NAME,
  DAEMON_DEV_SCRIPT,
  DAEMON_READY_SIGNAL,
  DAEMON_START_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
  LOCK_PATH,
  MCP_CLI_DIR,
  PID_MAX_AGE_MS,
  PID_PATH,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SOCKET_PATH,
} from "./constants.js";
import type { IpcMethod, IpcRequest, IpcResponse } from "./ipc.js";
import { nextId } from "./ipc.js";

/**
 * Send a single request to the daemon and return the response.
 * Auto-starts the daemon if it's not running.
 */
export async function ipcCall(method: IpcMethod, params?: unknown): Promise<unknown> {
  await ensureDaemon();

  const request: IpcRequest = { id: nextId(), method, params };
  const response = await sendRequest(request);

  if (response.error) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  return response.result;
}

/** Send a request via HTTP-over-Unix-socket and return the response */
async function sendRequest(request: IpcRequest): Promise<IpcResponse> {
  const res = await fetch("http://localhost/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    unix: SOCKET_PATH,
    signal: AbortSignal.timeout(IPC_REQUEST_TIMEOUT_MS),
  } as RequestInit);

  if (!res.ok) {
    throw new Error(`IPC HTTP error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as IpcResponse;
}

/**
 * Check if daemon is running, start it if not.
 * Uses an exclusive lock file to prevent concurrent startups (race condition).
 */
async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  // If the daemon is alive but has the wrong protocol version, shut it down first
  if (versionMismatchPid !== null) {
    await stopDaemon();
    versionMismatchPid = null;
  }

  // Try to acquire exclusive lock
  let lockFd: number | null = null;
  try {
    mkdirSync(MCP_CLI_DIR, { recursive: true });
    lockFd = openSync(LOCK_PATH, "wx"); // O_WRONLY | O_CREAT | O_EXCL — atomic
  } catch {
    // Another process holds the lock — wait for daemon to appear
    await waitForDaemon();
    return;
  }

  try {
    // Double-check after acquiring lock (daemon may have started between our check and lock)
    if (await isDaemonRunning()) return;

    // Re-check mismatch after lock (another CLI may not have restarted yet)
    if (versionMismatchPid !== null) {
      await stopDaemon();
      versionMismatchPid = null;
    }

    await startDaemon();
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  }
}

/** Wait for another process to finish starting the daemon */
async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return;
    await Bun.sleep(100);
  }
  // Lock may be stale — clean it up and try once more
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
  if (await isDaemonRunning()) return;
  throw new Error(`Timed out waiting for daemon to start (${DAEMON_START_TIMEOUT_MS}ms)`);
}

/** Remove stale PID and socket files so a fresh daemon can start */
function cleanStaleFiles(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    /* already gone */
  }
}

/** Verify the process at `pid` is actually mcpd (guards against PID recycling) */
export function isProcessMcpd(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    const output = result.stdout.toString().trim();
    // Match compiled binary (mcpd) or dev script (daemon/src/index)
    return output.includes(DAEMON_BINARY_NAME) || output.includes(DAEMON_DEV_SCRIPT);
  } catch {
    return false;
  }
}

/** Set when isDaemonRunning detects a version-mismatched daemon that needs to be stopped */
let versionMismatchPid: number | null = null;

/** Send shutdown command to a running daemon and clean up stale files */
async function stopDaemon(): Promise<void> {
  try {
    await fetch("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: nextId(), method: "shutdown" }),
      unix: SOCKET_PATH,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    } as RequestInit);
    // Wait briefly for the daemon process to exit
    await Bun.sleep(200);
  } catch {
    // Daemon may already be unreachable — fall through to clean up
  }
  cleanStaleFiles();
}

/** Send a quick HTTP ping to verify the daemon is responsive */
function pingDaemon(): Promise<boolean> {
  return fetch("http://localhost/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: nextId(), method: "ping" }),
    unix: SOCKET_PATH,
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  } as RequestInit)
    .then((res) => res.ok)
    .catch(() => false);
}

/**
 * Layered daemon liveness check:
 * 1. PID file exists and is parseable
 * 2. startedAt is not unreasonably old
 * 3. Process exists at that PID
 * 4. Process is actually mcpd (not a recycled PID)
 * 5. Socket file exists
 * 6. Daemon responds to IPC ping
 */
export async function isDaemonRunning(): Promise<boolean> {
  versionMismatchPid = null;

  if (!existsSync(PID_PATH)) return false;

  let data: { pid: number; startedAt: number; protocolVersion?: string };
  try {
    data = JSON.parse(readFileSync(PID_PATH, "utf-8"));
  } catch {
    cleanStaleFiles();
    return false;
  }

  // Reject unreasonably old PID files
  if (typeof data.startedAt !== "number" || Date.now() - data.startedAt > PID_MAX_AGE_MS) {
    cleanStaleFiles();
    return false;
  }

  // Check if process is alive
  try {
    process.kill(data.pid, 0);
  } catch {
    cleanStaleFiles();
    return false;
  }

  // Verify the process is actually mcpd (not a recycled PID)
  if (!isProcessMcpd(data.pid)) {
    cleanStaleFiles();
    return false;
  }

  // Protocol version mismatch — daemon is alive but wrong version
  if (data.protocolVersion !== PROTOCOL_VERSION) {
    console.error(
      `[mcp] Protocol version mismatch (daemon: ${data.protocolVersion ?? "unknown"}, cli: ${PROTOCOL_VERSION}). Restarting daemon...`,
    );
    versionMismatchPid = data.pid;
    return false;
  }

  // Socket must exist (but don't clean PID — daemon might be initializing)
  if (!existsSync(SOCKET_PATH)) return false;

  // Definitive check: daemon responds to ping
  const alive = await pingDaemon();
  if (!alive) {
    cleanStaleFiles();
    return false;
  }

  return true;
}

/**
 * Resolve the command to launch the daemon.
 *
 * 1. Compiled mode: look for `mcpd` binary next to the current executable.
 * 2. Dev mode: walk up from this file to find the workspace root, then resolve the daemon script.
 * 3. Fallback: assume `mcpd` is on PATH.
 */
export function resolveDaemonCommand(): string[] {
  // Compiled mode: mcpd binary next to current executable
  const siblingBinary = join(dirname(process.execPath), DAEMON_BINARY_NAME);
  if (existsSync(siblingBinary)) return [siblingBinary];

  // Dev mode: walk up from this file to find workspace root, then resolve daemon script
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, DAEMON_DEV_SCRIPT);
    if (existsSync(candidate)) return ["bun", "run", candidate];
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: assume mcpd is on PATH
  return [DAEMON_BINARY_NAME];
}

/** Spawn the daemon as a detached background process */
async function startDaemon(): Promise<void> {
  const cmd = resolveDaemonCommand();

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drain stderr in parallel to prevent pipe buffer deadlock (64KB limit).
  // Capture output for inclusion in timeout error messages.
  let stderrOutput = "";
  const stderrDrain = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrOutput += decoder.decode(value, { stream: true });
    }
    stderrOutput += decoder.decode(); // flush
  })();

  const stdoutDecoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let stdout = "";

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    stdout += stdoutDecoder.decode(value, { stream: true });
    if (stdout.includes(DAEMON_READY_SIGNAL)) {
      proc.unref();
      return;
    }
  }

  proc.kill();
  await stderrDrain.catch(() => {}); // collect any remaining stderr
  const details = [stdout && `stdout: ${stdout.trim()}`, stderrOutput && `stderr: ${stderrOutput.trim()}`]
    .filter(Boolean)
    .join("; ");
  throw new Error(`Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms${details ? `. ${details}` : ""}`);
}
