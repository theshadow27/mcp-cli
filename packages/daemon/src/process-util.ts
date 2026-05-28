/**
 * Shared process lifecycle utilities.
 *
 * Extracted from ws-server.ts so server-pool.ts can reuse the same
 * SIGTERM → poll → SIGKILL escalation pattern (#940).
 */

import type { Logger } from "@mcp-cli/core";
import { spawnCaptureSync } from "@mcp-cli/core";
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

/** Poll `process.kill(pid, 0)` until the process exits or deadline is reached. */
async function awaitExit(pid: number, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    await Bun.sleep(POLL_INTERVAL_MS);
    try {
      process.kill(pid, 0);
    } catch {
      return true; // process exited
    }
  }
  return false; // still alive
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

  if (!trySendSignal(pid, "SIGTERM", logger)) return;

  // Poll for exit up to killTimeoutMs
  if (await awaitExit(pid, Date.now() + killTimeoutMs)) return;

  // Still alive — escalate to SIGKILL
  logger.error(`[process] PID ${pid} did not exit after SIGTERM — sending SIGKILL`);
  if (!trySendSignal(pid, "SIGKILL", logger)) return;

  // Wait briefly for SIGKILL to take effect
  await awaitExit(pid, Date.now() + KILL_SIGKILL_GRACE_MS);
}

/**
 * Find PIDs of processes whose cwd is under `dirPath`.
 * Uses `lsof -a -d cwd +D <dir>` to match any process with a cwd
 * at or under the given directory. Returns only PIDs that differ from
 * the current process (we never self-kill).
 */
export function findProcessesByCwd(dirPath: string, logger: Logger): number[] {
  const myPid = process.pid;
  try {
    const result = spawnCaptureSync("lsof", ["-a", "-d", "cwd", "+D", dirPath, "-t"], {
      timeoutMs: LSOF_TIMEOUT_MS,
    });
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
    logger.warn(`[process] lsof scan for cwd under ${dirPath} failed: ${err}`);
    return [];
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
export function reapWorktreeProcesses(worktreePath: string, logger: Logger): number {
  const pids = findProcessesByCwd(worktreePath, logger);
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
