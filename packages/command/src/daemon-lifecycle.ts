/**
 * Daemon lifecycle management — CLI-specific startup, shutdown, and liveness checks.
 *
 * Moved from core/src/ipc-client.ts: these functions depend on the filesystem
 * layout, process spawning, and PID file mechanics that are CLI concerns,
 * not shared IPC transport.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import {
  BUILD_VERSION,
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
  resolveDaemonCommand as coreResolveDaemonCommand,
  ensureStateDir,
  nextId,
  options,
  pingDaemon,
  rawFetch,
} from "@mcp-cli/core";

/** Thrown when shutdown is refused because active sessions exist. */
export class ShutdownRefusedError extends Error {
  constructor(
    message: string,
    public readonly activeSessions: number,
  ) {
    super(message);
    this.name = "ShutdownRefusedError";
  }
}

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
    // Match compiled binary (mcpd) or dev script (daemon/src/main)
    const match = output.includes(DAEMON_BINARY_NAME) || output.includes(DAEMON_DEV_SCRIPT);
    if (match) verifiedMcpdPid = pid;
    return match;
  } catch {
    return false;
  }
}

/** Send shutdown command to a running daemon and wait for it to exit.
 *  If force is false and active sessions exist, throws with the refusal message. */
export async function stopDaemon(opts?: { force?: boolean }): Promise<void> {
  // Read the PID before sending shutdown so we can wait for the process to exit
  const pidData = readLivePidData();
  verifiedMcpdPid = null;
  try {
    const res = await rawFetch({ id: nextId(), method: "shutdown", params: { force: opts?.force } }, PING_TIMEOUT_MS);
    const body = (await res.json()) as { result?: { ok: boolean; activeSessions?: number; message?: string } };
    if (body.result && !body.result.ok) {
      throw new ShutdownRefusedError(body.result.message ?? "Shutdown refused", body.result.activeSessions ?? 0);
    }
  } catch (err) {
    if (err instanceof ShutdownRefusedError) throw err;
    // Daemon may already be unreachable — fall through to clean up
  }

  // Wait for the daemon process to actually exit before cleaning up files.
  // Without this, the next `ensureDaemon()` call may see no PID file, spawn
  // a new daemon, and race with the old one for the socket (EEXIST).
  if (pidData) {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        process.kill(pidData.pid, 0); // probe — throws if dead
        await Bun.sleep(50);
      } catch {
        break; // process is gone
      }
    }
  }

  cleanStaleFiles();
}

/**
 * Parse PID file and verify the daemon process is live (fresh, alive, is mcpd).
 * Returns the parsed data on success, null on any failure.
 * Does NOT clean up stale files — callers decide based on context.
 */
function readLivePidData(): {
  pid: number;
  startedAt: number;
  protocolVersion?: string;
  buildVersion?: string;
} | null {
  let data: { pid: number; startedAt: number; protocolVersion?: string; buildVersion?: string };
  try {
    data = JSON.parse(readFileSync(options.PID_PATH, "utf-8"));
  } catch {
    return null;
  }

  if (typeof data.startedAt !== "number" || Date.now() - data.startedAt > PID_MAX_AGE_MS) {
    return null;
  }

  try {
    process.kill(data.pid, 0);
  } catch {
    return null;
  }

  if (!isProcessMcpd(data.pid)) return null;

  return data;
}

/**
 * Check if a daemon process is alive but still initializing (socket not yet ready).
 *
 * Returns true when the daemon is alive (valid PID, process is mcpd) but its socket
 * does not exist yet. Used by ensureDaemon() to wait for an in-progress startup
 * rather than spawn a second daemon.
 */
export function isDaemonInitializing(): boolean {
  const data = readLivePidData();
  if (!data) return false;
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
  const data = readLivePidData();
  if (!data) {
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

/** Resolve the command to launch the daemon — delegates to core. */
export function resolveDaemonCommand(): string[] {
  return coreResolveDaemonCommand(import.meta.dir);
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

/**
 * Compare a daemon's build version against the CLI's BUILD_VERSION.
 * Returns a warning string if they differ, null if they match.
 * Exported with underscore prefix for testing.
 */
export function _buildStaleDaemonWarning(daemonBuildVersion: string | undefined): string | null {
  if (!daemonBuildVersion || daemonBuildVersion !== BUILD_VERSION) {
    if (!daemonBuildVersion) {
      return `Daemon predates build version tracking (CLI is ${BUILD_VERSION}). Run \`mcx shutdown\` to pick up the new binary.`;
    }
    return `Daemon is running a different build (${daemonBuildVersion}) than CLI (${BUILD_VERSION}). Run \`mcx shutdown\` to pick up the new binary.`;
  }
  return null;
}

/**
 * Check if the running daemon was built from an older binary than the CLI.
 * Returns a warning string if stale, null otherwise.
 * Reads the PID file (no IPC call) so it's cheap to call from any command.
 */
export function getStaleDaemonWarning(): string | null {
  const data = readLivePidData();
  if (!data) return null;
  return _buildStaleDaemonWarning(data.buildVersion);
}
