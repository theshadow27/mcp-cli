/**
 * Daemon lifecycle management — CLI-specific startup, shutdown, and liveness checks.
 *
 * Moved from core/src/ipc-client.ts: these functions depend on the filesystem
 * layout, process spawning, and PID file mechanics that are CLI concerns,
 * not shared IPC transport.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import {
  DAEMON_BINARY_NAME,
  DAEMON_DEV_SCRIPT,
  DAEMON_READY_SIGNAL,
  DAEMON_START_COOLDOWN_MS,
  DAEMON_START_TIMEOUT_MS,
  DaemonStartCooldownError,
  PID_MAX_AGE_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  ProtocolMismatchError,
  ipcCall as coreIpcCall,
  ensureStateDir,
  findFileUpward,
  nextId,
  options,
  pingDaemon,
  rawFetch,
} from "@mcp-cli/core";

/** Timestamp of the last failed daemon start attempt (0 = no recent failure) */
let lastStartFailureAt = 0;

/** Reset the start cooldown — exported for testing only */
export function _resetStartCooldown(): void {
  lastStartFailureAt = 0;
}

/**
 * Send a single request to the daemon, auto-starting it if needed.
 * Wraps core's ipcCall with ensureDaemon for CLI use.
 */
export async function ipcCall<M extends IpcMethod>(
  method: M,
  params?: unknown,
  opts?: { timeoutMs?: number },
): Promise<IpcMethodResult[M]> {
  await ensureDaemon();
  return coreIpcCall(method, params, opts);
}

/**
 * Check if daemon is running, start it if not.
 * Uses an exclusive lock file to prevent concurrent startups (race condition).
 */
export async function ensureDaemon(): Promise<void> {
  // isDaemonRunning() throws ProtocolMismatchError if versions don't match — fail-fast.
  if (await isDaemonRunning()) return;

  // Daemon is alive but its IPC socket isn't ready yet — wait for it, don't spawn a second one.
  if (isDaemonInitializing()) {
    await waitForDaemon();
    return;
  }

  // Cooldown guard: if we recently failed to start, don't try again immediately.
  // Prevents unbounded spawn loops when the daemon binary is broken.
  const elapsed = Date.now() - lastStartFailureAt;
  if (lastStartFailureAt > 0 && elapsed < DAEMON_START_COOLDOWN_MS) {
    throw new DaemonStartCooldownError(DAEMON_START_COOLDOWN_MS - elapsed);
  }

  // Try to acquire exclusive lock
  let lockFd: number | null = null;
  try {
    ensureStateDir();
    lockFd = openSync(options.LOCK_PATH, "wx"); // O_WRONLY | O_CREAT | O_EXCL — atomic
  } catch {
    // Another process holds the lock — wait for daemon to appear
    await waitForDaemon();
    return;
  }

  try {
    // Double-check after acquiring lock (daemon may have started between our check and lock)
    if (await isDaemonRunning()) return;

    await startDaemon();
  } catch (err) {
    // Only cooldown on actual start failures, not protocol mismatches
    // (daemon is running fine, just wrong version).
    if (!(err instanceof ProtocolMismatchError)) {
      lastStartFailureAt = Date.now();
    }
    throw err;
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    try {
      unlinkSync(options.LOCK_PATH);
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
    unlinkSync(options.LOCK_PATH);
  } catch {
    /* already gone */
  }
  if (await isDaemonRunning()) return;
  throw new Error(`Timed out waiting for daemon to start (${DAEMON_START_TIMEOUT_MS}ms)`);
}

/** Remove stale PID and socket files so a fresh daemon can start */
function cleanStaleFiles(): void {
  try {
    unlinkSync(options.PID_PATH);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(options.SOCKET_PATH);
  } catch {
    /* already gone */
  }
}

/** Cache: skip repeated `ps` calls for the same PID within a single CLI invocation */
let verifiedMcpdPid: number | null = null;

/** Verify the process at `pid` is actually mcpd (guards against PID recycling) */
export function isProcessMcpd(pid: number): boolean {
  if (pid === verifiedMcpdPid) return true;
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    const output = result.stdout.toString().trim();
    // Match compiled binary (mcpd) or dev script (daemon/src/index)
    const match = output.includes(DAEMON_BINARY_NAME) || output.includes(DAEMON_DEV_SCRIPT);
    if (match) verifiedMcpdPid = pid;
    return match;
  } catch {
    return false;
  }
}

/** Send shutdown command to a running daemon and clean up stale files */
export async function stopDaemon(): Promise<void> {
  verifiedMcpdPid = null;
  try {
    await rawFetch({ id: nextId(), method: "shutdown" }, PING_TIMEOUT_MS);
    // Wait briefly for the daemon process to exit
    await Bun.sleep(200);
  } catch {
    // Daemon may already be unreachable — fall through to clean up
  }
  cleanStaleFiles();
}

/**
 * Check if a daemon process is alive but still initializing (socket not yet ready).
 *
 * Returns true when:
 * - PID file exists and is parseable with a fresh startedAt
 * - Process at that PID is alive
 * - Process is actually mcpd (not a recycled PID)
 * - Socket file does NOT yet exist (daemon is still booting)
 *
 * Used by ensureDaemon() to wait for an in-progress startup rather than spawn a second daemon.
 */
export function isDaemonInitializing(): boolean {
  let data: { pid: number; startedAt: number };
  try {
    data = JSON.parse(readFileSync(options.PID_PATH, "utf-8"));
  } catch {
    return false;
  }

  if (typeof data.startedAt !== "number" || Date.now() - data.startedAt > PID_MAX_AGE_MS) {
    return false;
  }

  try {
    process.kill(data.pid, 0);
  } catch {
    return false;
  }

  if (!isProcessMcpd(data.pid)) return false;

  // Socket absent means daemon is still booting
  return !existsSync(options.SOCKET_PATH);
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
  let data: { pid: number; startedAt: number; protocolVersion?: string };
  try {
    data = JSON.parse(readFileSync(options.PID_PATH, "utf-8"));
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

  // Protocol version mismatch — daemon is alive but wrong version.
  // Fail-fast: never auto-restart, as that orphans active sessions.
  if (data.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(data.protocolVersion ?? "unknown", PROTOCOL_VERSION);
  }

  // Socket must exist (but don't clean PID — daemon might be initializing)
  if (!existsSync(options.SOCKET_PATH)) return false;

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
  const devScript = findFileUpward(DAEMON_DEV_SCRIPT, import.meta.dir);
  if (devScript) return ["bun", "run", devScript];

  // Fallback: assume mcpd is on PATH
  return [DAEMON_BINARY_NAME];
}

/** Spawn the daemon as a detached background process */
async function startDaemon(): Promise<void> {
  const cmd = resolveDaemonCommand();

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
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
  await stderrDrain.catch((e) => {
    stderrOutput += `\n[drain error: ${e instanceof Error ? e.message : String(e)}]`;
  });
  const details = [stdout && `stdout: ${stdout.trim()}`, stderrOutput && `stderr: ${stderrOutput.trim()}`]
    .filter(Boolean)
    .join("; ");
  throw new Error(`Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms${details ? `. ${details}` : ""}`);
}
