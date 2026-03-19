/**
 * Daemon lifecycle management — CLI-specific startup, shutdown, and liveness checks.
 *
 * Moved from core/src/ipc-client.ts: these functions depend on the filesystem
 * layout, process spawning, and PID file mechanics that are CLI concerns,
 * not shared IPC transport.
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Keys whose values must be redacted in verbose output to prevent secret leakage */
const REDACTED_KEY_PATTERN = /token|secret|key|password|credential|auth|apikey/i;

/** Redact sensitive values from an object before logging */
export function redactSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = REDACTED_KEY_PATTERN.test(k) ? "[REDACTED]" : redactSecrets(v);
  }
  return result;
}

/** Log a verbose message to stderr when MCX_VERBOSE=1 */
export function verboseLog(message: string): void {
  if (process.env.MCX_VERBOSE === "1") {
    console.error(`[mcx] ${message}`);
  }
}

/**
 * Send a single request to the daemon, auto-starting it if needed.
 * Wraps core's ipcCall with ensureDaemon for CLI use.
 *
 * Retries on transient connection errors (ECONNREFUSED, ENOENT) that can occur
 * in the brief window between ensureDaemon() confirming the daemon is up and
 * the actual IPC call — e.g. when multiple CLI processes connect simultaneously
 * right after daemon startup.
 */
export async function ipcCall<M extends IpcMethod>(
  method: M,
  params?: unknown,
  opts?: { timeoutMs?: number },
): Promise<IpcMethodResult[M]> {
  await ensureDaemon();

  const verbose = process.env.MCX_VERBOSE === "1";
  if (verbose) {
    const paramStr = params !== undefined ? ` ${JSON.stringify(redactSecrets(params))}` : "";
    const timeoutStr = opts?.timeoutMs ? ` (timeout: ${opts.timeoutMs}ms)` : "";
    console.error(`[mcx] ipc → ${method}${paramStr}${timeoutStr}`);
  }
  const start = verbose ? performance.now() : 0;

  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await coreIpcCall(method, params, opts);
      if (verbose) {
        const elapsed = (performance.now() - start).toFixed(1);
        const resultStr = JSON.stringify(result);
        const preview = resultStr.length > 200 ? `${resultStr.slice(0, 200)}…` : resultStr;
        console.error(`[mcx] ipc ← ${method} (${elapsed}ms) ${preview}`);
      }
      return result;
    } catch (err) {
      if (attempt < maxRetries && _isTransientConnectionError(err)) {
        await Bun.sleep(100 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/** Check if an error is a transient connection failure (socket not ready yet) — exported for testing */
export function _isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("ECONNREFUSED") || msg.includes("ENOENT") || msg.includes("ConnectionRefused");
}

/**
 * Check if daemon is running, start it if not.
 * Uses an exclusive lock file to prevent concurrent startups (race condition).
 */
export async function ensureDaemon(): Promise<void> {
  // isDaemonRunning() throws ProtocolMismatchError if versions don't match — fail-fast.
  if (await isDaemonRunning()) {
    verboseLog("daemon already running");
    return;
  }

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

    verboseLog("starting daemon...");
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

/**
 * Wait for another process to finish starting the daemon.
 *
 * Uses 2x DAEMON_START_TIMEOUT_MS because waiters start their countdown before
 * the lock winner even begins spawning the daemon. Under CI load, the daemon
 * spawn + init can consume most of the timeout window.
 *
 * Uses isDaemonReachable() instead of isDaemonRunning() to avoid destructive
 * cleanStaleFiles() calls during the startup window — a failed isProcessMcpd()
 * check (e.g. slow `ps` in CI) would otherwise delete files the daemon just created.
 */
async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS * 2;
  while (Date.now() < deadline) {
    if (await isDaemonReachable()) return;
    await Bun.sleep(100);
  }
  // Lock may be stale — clean it up and try once more
  try {
    unlinkSync(options.LOCK_PATH);
  } catch {
    /* already gone */
  }
  if (await isDaemonReachable()) return;
  throw new Error(`Timed out waiting for daemon to start (${DAEMON_START_TIMEOUT_MS * 2}ms)`);
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
 * Non-destructive daemon reachability check for polling during startup.
 *
 * Unlike isDaemonRunning(), this never calls cleanStaleFiles(). During the
 * concurrent auto-start window, multiple CLI processes poll in waitForDaemon().
 * If isProcessMcpd() transiently fails (slow `ps` under CI load), a destructive
 * check would delete the PID/socket files the daemon just created, making it
 * permanently unreachable.
 */
async function isDaemonReachable(): Promise<boolean> {
  if (!existsSync(options.SOCKET_PATH)) return false;
  return pingDaemon();
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

/**
 * Extract the build epoch (Unix seconds) from BUILD_VERSION.
 * Returns null in dev mode (no epoch suffix).
 */
export function _parseBuildEpoch(buildVersion: string): number | null {
  const match = buildVersion.match(/\+(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Find the newest mtime (seconds) among source files in a packages/ subdirectory.
 * Only scans `src/` within each package. Returns { pkg, mtimeSec } or null.
 */
function newestSourceMtime(packagesDir: string): { pkg: string; mtimeSec: number }[] {
  const stalePackages: { pkg: string; mtimeSec: number }[] = [];
  let pkgs: string[];
  try {
    pkgs = readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return stalePackages;
  }

  for (const pkg of pkgs) {
    const srcDir = join(packagesDir, pkg, "src");
    let newest = 0;
    try {
      const files = readdirSync(srcDir, { withFileTypes: true, recursive: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const fullPath = join(f.parentPath ?? srcDir, f.name);
        const mtime = statSync(fullPath).mtimeMs / 1000;
        if (mtime > newest) newest = mtime;
      }
    } catch {
      continue;
    }
    if (newest > 0) stalePackages.push({ pkg, mtimeSec: newest });
  }
  return stalePackages;
}

/**
 * Check if any source files under packages/ are newer than the compiled binary.
 * Returns a warning string if stale, null otherwise.
 * Only applies in compiled mode (BUILD_VERSION contains +epoch).
 *
 * @param workspaceRoot - override for testing; defaults to auto-detection
 */
export function getSourceStalenessWarning(workspaceRoot?: string): string | null {
  const buildEpoch = _parseBuildEpoch(BUILD_VERSION);
  if (buildEpoch === null) return null; // dev mode — source is always live

  // Find workspace root: walk up from the binary's directory looking for packages/
  let root = workspaceRoot;
  if (!root) {
    let dir = dirname(process.execPath);
    while (true) {
      if (existsSync(join(dir, "packages"))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) return null; // no workspace found (installed globally)
      dir = parent;
    }
  }

  const packagesDir = join(root, "packages");
  const entries = newestSourceMtime(packagesDir);
  const stale = entries.filter((e) => e.mtimeSec > buildEpoch);

  if (stale.length === 0) return null;

  const pkgList = stale.map((s) => s.pkg).join(", ");
  const newestAge = Math.max(...stale.map((s) => s.mtimeSec)) - buildEpoch;
  const ageStr = formatAge(newestAge);

  return `dist/ binaries were built before latest source changes (${pkgList} modified ${ageStr} after build).\n  Run: bun run build && mcx daemon restart`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
