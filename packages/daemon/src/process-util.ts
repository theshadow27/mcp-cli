/**
 * Shared process lifecycle utilities.
 *
 * Extracted from ws-server.ts so server-pool.ts can reuse the same
 * SIGTERM → poll → SIGKILL escalation pattern (#940).
 */

import type { Logger } from "@mcp-cli/core";
import { isOurProcess } from "./process-identity";

/** Time (ms) to wait after SIGTERM before escalating to SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;
/** Time (ms) to wait after SIGKILL before giving up. */
const KILL_SIGKILL_GRACE_MS = 2_000;
/** Interval (ms) between liveness checks while waiting for process exit. */
const POLL_INTERVAL_MS = 100;

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
 * Error handling:
 * - ESRCH (no such process) is silently swallowed — process already dead.
 * - EPERM (not permitted) is logged as a warning — we don't own this PID.
 * - All other errors are logged and swallowed to avoid crashing callers.
 */
export async function killPid(
  pid: number,
  logger: Logger,
  opts?: { pidStartTime?: number | null; killTimeoutMs?: number },
): Promise<void> {
  const killTimeoutMs = opts?.killTimeoutMs ?? KILL_TIMEOUT_MS;

  // Verify PID ownership before sending signals
  if (opts?.pidStartTime != null) {
    if (!isOurProcess(pid, opts.pidStartTime)) {
      logger.warn(`[process] PID ${pid} has been recycled — skipping kill`);
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
