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

/**
 * Kill any orphaned claude processes from the previous daemon run.
 *
 * Queries the DB for sessions that were not cleanly ended (ended_at IS NULL),
 * SIGTERMs any alive PIDs, and marks all such sessions as ended.
 *
 * Returns the count of processes actually killed (process existed and was signaled).
 */
export function reapOrphanedSessions(db: StateDb, logger: Logger = consoleLogger): number {
  const activeSessions = db.listSessions(true); // active = ended_at IS NULL
  let reaped = 0;

  for (const session of activeSessions) {
    const { sessionId, pid } = session;

    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
        logger.error(`[mcpd] Reaped orphaned claude process pid=${pid} (session ${sessionId})`);
        reaped++;
      } catch {
        // Process already dead — nothing to do
      }
    }

    // Mark session as ended regardless of whether we killed the process
    db.endSession(sessionId);
  }

  return reaped;
}
