/**
 * Shared process lifecycle utilities.
 *
 * Extracted from ws-server.ts so server-pool.ts can reuse the same
 * SIGTERM → poll → SIGKILL escalation pattern (#940).
 */

import type { Logger } from "@mcp-cli/core";
import { listDescendantPids, spawnCapture } from "@mcp-cli/core";
import { findPidsByCwdLinux } from "./proc-fs";
import { isOurProcess } from "./process-identity";

/** Time (ms) to wait after SIGTERM before escalating to SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;
/** Time (ms) to wait after SIGKILL before giving up. */
const KILL_SIGKILL_GRACE_MS = 2_000;
/** Interval (ms) between liveness checks while waiting for process exit. */
const POLL_INTERVAL_MS = 100;
/** Cache age (ms) below which PID-recycling is near-impossible — skip jittery isOurProcess (#2437). */
const FRESH_CACHE_MS = 30_000;
/** Timeout (ms) for lsof scan when finding processes by cwd. */
const LSOF_TIMEOUT_MS = 5_000;

/**
 * Try to send a signal to a process. Returns true if the signal was sent
 * successfully, false if the process is dead or we lack permission.
 * Logs EPERM and unexpected errors as warnings.
 */
function trySendSignal(pid: number, signal: NodeJS.Signals, logger: Logger): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // already dead
    if (code === "EPERM") {
      logger.warn(`[process] PID ${pid}: EPERM on ${signal}`);
      return false;
    }
    logger.warn(`[process] PID ${pid}: unexpected error on ${signal}: ${err}`);
    return false;
  }
}

/** True if `process.kill(pid, 0)` succeeds. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until every PID has exited, or the deadline is reached. */
async function awaitExitAll(pids: number[], deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (pids.every((p) => !isPidAlive(p))) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return pids.every((p) => !isPidAlive(p));
}

/**
 * Kill a process by PID with SIGTERM → SIGKILL escalation.
 *
 * Polls `process.kill(pid, 0)` to detect exit. If the process does not
 * exit within `killTimeoutMs` after SIGTERM, escalates to SIGKILL.
 *
 * If `pidStartTime` is provided, verifies the PID still belongs to the
 * original process before sending any signals. This prevents killing an
 * unrelated process when the PID has been recycled by the OS.
 *
 * If `cachedAtMs` is also provided and the cache is less than `FRESH_CACHE_MS`
 * old, the ownership check is skipped — PID recycling within that window is
 * near-impossible, and the `ps -o etime=` parser jitters under CI load (#2437).
 *
 * Error handling:
 * - ESRCH (no such process) is silently swallowed — process already dead.
 * - EPERM (not permitted) is logged as a warning — we don't own this PID.
 * - All other errors are logged and swallowed to avoid crashing callers.
 */
export async function killPid(
  pid: number,
  logger: Logger,
  opts?: { pidStartTime?: number | null; killTimeoutMs?: number; cachedAtMs?: number },
): Promise<void> {
  const killTimeoutMs = opts?.killTimeoutMs ?? KILL_TIMEOUT_MS;

  const cacheAge = opts?.cachedAtMs != null ? Date.now() - opts.cachedAtMs : null;
  const isFreshCache = cacheAge != null && cacheAge >= 0 && cacheAge < FRESH_CACHE_MS;
  if (opts?.pidStartTime != null && !isFreshCache) {
    const ownership = isOurProcess(pid, opts.pidStartTime);
    if (ownership === false) {
      logger.warn(`[process] PID ${pid} has been recycled (start time mismatch) — skipping kill`);
      return;
    }
  }

  // Snapshot the tree first: a wrapper (pnpm/nvm `bun` shim) dies on SIGTERM
  // and would otherwise leave its child reparented to PID 1, unkillable by
  // a later walk of this PID. Never walk PID 1 itself — that tree is the
  // whole machine (the EPERM fixture calls killPid(1)). #3459
  const tree = pid <= 1 ? [pid] : [pid, ...listDescendantPids(pid)];
  let signaled = false;
  for (const target of tree) {
    if (trySendSignal(target, "SIGTERM", logger)) signaled = true;
  }
  if (!signaled) return;

  // Poll until every process in the snapshot is gone, not just the root.
  if (await awaitExitAll(tree, Date.now() + killTimeoutMs)) return;

  // Still alive — escalate to SIGKILL
  logger.error(`[process] PID ${pid} did not exit after SIGTERM — sending SIGKILL`);
  for (const target of tree) {
    trySendSignal(target, "SIGKILL", logger);
  }

  // Wait briefly for SIGKILL to take effect
  await awaitExitAll(tree, Date.now() + KILL_SIGKILL_GRACE_MS);
}

/**
 * Find PIDs of processes whose cwd is under `dirPath`.
 * Uses `lsof -a -d cwd +d <dir>` (lowercase +d — single-level, no recursive
 * filesystem walk) to match processes with a cwd at or directly under the
 * directory. Returns only PIDs that differ from the current process.
 */
export async function findProcessesByCwd(
  dirPath: string,
  logger: Logger,
  _spawnCaptureFn = spawnCapture,
): Promise<number[]> {
  const myPid = process.pid;
  try {
    const result = await _spawnCaptureFn("lsof", ["-a", "-d", "cwd", "+d", dirPath, "-t"], {
      timeoutMs: LSOF_TIMEOUT_MS,
    });
    if (result.timedOut) {
      logger.warn(`[process] lsof scan timed out for ${dirPath} — trying /proc fallback`);
      return fallbackPidsByCwd(dirPath, myPid);
    }
    if (result.exitCode === null) {
      logger.warn(`[process] lsof unavailable for ${dirPath} — trying /proc fallback`);
      return fallbackPidsByCwd(dirPath, myPid);
    }
    if (!result.ok && result.stderr.trim()) {
      logger.debug(`[process] lsof exited ${result.exitCode} for ${dirPath}: ${result.stderr.trim()}`);
    }
    const stdout = result.stdout.trim();
    if (!stdout) return [];
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== myPid) {
        pids.push(pid);
      }
    }
    return pids;
  } catch (err) {
    logger.warn(`[process] lsof scan for cwd under ${dirPath} failed: ${err} — trying /proc fallback`);
    return fallbackPidsByCwd(dirPath, myPid);
  }
}

/**
 * Kill all processes whose cwd is under the given worktree directory.
 * Intended for post-bye cleanup: detached grandchild processes (bun test
 * workers, am-i-done runners) that reparent to PID 1 when the session
 * process is killed. SIGKILL is used directly since these are already
 * orphaned — no point in a graceful SIGTERM handshake.
 *
 * Returns the count of processes killed.
 */
export async function reapWorktreeProcesses(worktreePath: string, logger: Logger): Promise<number> {
  const pids = await findProcessesByCwd(worktreePath, logger);
  if (pids.length === 0) return 0;

  logger.info(`[process] Reaping ${pids.length} orphaned process(es) under ${worktreePath}: ${pids.join(", ")}`);
  let killed = 0;
  for (const pid of pids) {
    if (trySendSignal(pid, "SIGKILL", logger)) {
      killed++;
    }
  }
  return killed;
}

/** /proc cwd scan when lsof is missing or hung. Empty on non-Linux. */
function fallbackPidsByCwd(dirPath: string, myPid: number): number[] {
  if (process.platform !== "linux") return [];
  return findPidsByCwdLinux(dirPath, myPid);
}
