/**
 * Stale process reaper — run on daemon startup to clean up DB records for
 * sessions whose processes are already dead.
 *
 * On normal shutdown, terminateSession() kills each spawned process.
 * On unclean exit (kill -9, crash), those processes keep running indefinitely.
 *
 * IMPORTANT: The reaper does NOT kill alive processes. Alive sessions are
 * preserved so that restoreActiveSessions() can pick them up. This allows
 * daemon restarts (including self-restarts) to keep existing sessions running.
 */

import type { Logger } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import type { StateDb } from "./db/state";
import { isOurProcess as defaultIsOurProcess } from "./process-identity";

interface ReaperDeps {
  /** Injectable for testing — defaults to the real isOurProcess. */
  isOurProcess?: (pid: number, storedStartTimeMs: number) => boolean;
}

/**
 * Clean up DB records for sessions whose processes are no longer alive.
 *
 * Queries the DB for sessions that were not cleanly ended (ended_at IS NULL).
 * For each session:
 * - No PID: mark as ended (can't restore without a process)
 * - PID alive and verified: SKIP (leave for restoreActiveSessions)
 * - PID dead or recycled: mark as ended (cleanup stale DB record)
 *
 * Returns the count of sessions cleaned up.
 */
export function reapOrphanedSessions(db: StateDb, logger: Logger = consoleLogger, deps?: ReaperDeps): number {
  const checkIsOurProcess = deps?.isOurProcess ?? defaultIsOurProcess;
  const activeSessions = db.listSessions(true); // active = ended_at IS NULL
  let cleaned = 0;

  for (const session of activeSessions) {
    const { sessionId, pid, pidStartTime } = session;

    if (pid === null) {
      // No PID — can't verify or restore, mark as ended
      db.endSession(sessionId);
      cleaned++;
      continue;
    }

    if (pidStartTime != null) {
      // We have a stored start time — verify PID ownership
      if (checkIsOurProcess(pid, pidStartTime)) {
        // Process is alive and matches — preserve for restoreActiveSessions
        logger.info(`[mcpd] Preserving active session ${sessionId} (pid ${pid} still alive)`);
        continue;
      }
      // PID is dead or recycled — clean up DB record
      logger.warn(`[mcpd] Cleaning up stale session ${sessionId} — pid ${pid} is dead or recycled`);
    } else {
      // Legacy session without start time — check bare liveness
      try {
        process.kill(pid, 0); // signal 0 = existence check, no kill
        // Process is alive — preserve it
        logger.info(`[mcpd] Preserving active session ${sessionId} (pid ${pid} still alive, no start time)`);
        continue;
      } catch {
        // Process is dead — clean up
        logger.warn(`[mcpd] Cleaning up stale session ${sessionId} — pid ${pid} is no longer alive`);
      }
    }

    db.endSession(sessionId);
    cleaned++;
  }

  return cleaned;
}
