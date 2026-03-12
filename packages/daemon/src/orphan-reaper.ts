/**
 * Stale process reaper — run on daemon startup to clean up claude processes
 * that became orphans after an unclean daemon exit (SIGKILL, crash, OOM).
 *
 * On normal shutdown, terminateSession() kills each spawned process.
 * On unclean exit (kill -9, crash), those processes keep running indefinitely.
 * The DB still has their PIDs and non-null ended_at rows let us find them.
 */

import type { Logger } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import type { StateDb } from "./db/state";
import { isOurProcess } from "./process-identity";

/**
 * Kill any orphaned claude processes from the previous daemon run.
 *
 * Queries the DB for sessions that were not cleanly ended (ended_at IS NULL),
 * SIGTERMs any alive PIDs (after verifying PID ownership via start time),
 * and marks all such sessions as ended.
 *
 * Returns the count of processes actually killed (process existed and was signaled).
 */
export function reapOrphanedSessions(db: StateDb, logger: Logger = consoleLogger): number {
  const activeSessions = db.listSessions(true); // active = ended_at IS NULL
  let reaped = 0;

  for (const session of activeSessions) {
    const { sessionId, pid, pidStartTime } = session;

    if (pid !== null) {
      // If we have a stored start time, verify the PID hasn't been recycled
      // before sending SIGTERM. Without this check, a recycled PID could
      // cause us to kill an unrelated process (nginx, database, etc.).
      if (pidStartTime != null && !isOurProcess(pid, pidStartTime)) {
        logger.warn(`[mcpd] Skipping orphan reap for session ${sessionId} — pid ${pid} has been recycled`);
      } else {
        try {
          process.kill(pid, "SIGTERM");
          logger.warn(`[mcpd] Reaped orphaned claude process pid=${pid} (session ${sessionId})`);
          reaped++;
        } catch {
          // Process already dead — nothing to do
        }
      }
    }

    // Mark session as ended regardless of whether we killed the process
    db.endSession(sessionId);
  }

  return reaped;
}
