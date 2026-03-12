/**
 * Process identity verification — prevents PID reuse from causing
 * SIGTERM to wrong processes or ghost sessions.
 *
 * Uses `ps -o etime=` (elapsed time since start) to derive a process's
 * start time. This is timezone-immune — unlike `lstart=`, elapsed time does
 * not depend on the system timezone or DST transitions.
 */

/**
 * Parse `ps -o etime=` output format [[dd-]hh:]mm:ss into total seconds.
 */
export function parseEtime(etime: string): number | null {
  const trimmed = etime.trim();
  if (!trimmed) return null;

  // Format: [[dd-]hh:]mm:ss
  let days = 0;
  let rest = trimmed;

  const dashIdx = rest.indexOf("-");
  if (dashIdx !== -1) {
    days = Number.parseInt(rest.slice(0, dashIdx), 10);
    if (Number.isNaN(days)) return null;
    rest = rest.slice(dashIdx + 1);
  }

  const parts = rest.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts as [number, number, number];
  } else if (parts.length === 2) {
    [minutes, seconds] = parts as [number, number];
  } else if (parts.length === 1) {
    [seconds] = parts as [number];
  } else {
    return null;
  }

  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Get the start time (epoch ms) of a process by PID.
 * Returns null if the process doesn't exist or the start time can't be determined.
 */
export function getProcessStartTime(pid: number): number | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)]);
    if (result.exitCode !== 0) return null;
    const elapsedSeconds = parseEtime(result.stdout.toString());
    if (elapsedSeconds === null) return null;
    return Date.now() - elapsedSeconds * 1000;
  } catch {
    return null;
  }
}

/**
 * Get start times for multiple PIDs in a single ps call.
 * Returns a Map from PID to epoch ms start time.
 * PIDs that don't exist or can't be queried are omitted from the result.
 */
export function getProcessStartTimesBatch(pids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (pids.length === 0) return result;

  try {
    const pidArgs = pids.join(",");
    const proc = Bun.spawnSync(["ps", "-o", "pid=,etime=", "-p", pidArgs]);
    // ps may exit non-zero if some PIDs are invalid — still parse stdout

    const now = Date.now();
    const output = proc.stdout.toString().trim();
    if (!output) return result;

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: "  PID   ELAPSED" — split on whitespace
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) continue;
      const pidStr = trimmed.slice(0, spaceIdx);
      const etimeStr = trimmed.slice(spaceIdx).trim();
      const pid = Number.parseInt(pidStr, 10);
      if (Number.isNaN(pid)) continue;
      const elapsedSeconds = parseEtime(etimeStr);
      if (elapsedSeconds === null) continue;
      result.set(pid, now - elapsedSeconds * 1000);
    }
  } catch {
    // ps not available or failed — return empty map
  }

  return result;
}

/**
 * Check if a PID still belongs to the same process that was originally recorded.
 *
 * Compares the stored start time (from when the session was created) against
 * the current start time of the process at that PID. If they don't match,
 * the PID has been recycled by the OS and now belongs to a different process.
 *
 * @param pid - The process ID to check
 * @param storedStartTimeMs - The epoch ms start time recorded when the session was created
 * @param toleranceMs - Tolerance for start time comparison (default 2s, accounts for rounding)
 * @returns true if the PID belongs to our original process, false if recycled or dead
 */
export function isOurProcess(pid: number, storedStartTimeMs: number, toleranceMs = 2_000): boolean {
  const currentStartTime = getProcessStartTime(pid);
  if (currentStartTime === null) return false; // process is dead
  return Math.abs(currentStartTime - storedStartTimeMs) <= toleranceMs;
}

/**
 * Batch-check whether multiple PIDs still belong to their original processes.
 * Returns a Set of PIDs that are dead or have been recycled.
 *
 * @param pidStartTimes - Map from PID to stored start time (epoch ms)
 * @param toleranceMs - Tolerance for start time comparison (default 2s)
 */
export function findDeadPids(pidStartTimes: Map<number, number>, toleranceMs = 2_000): Set<number> {
  const dead = new Set<number>();
  if (pidStartTimes.size === 0) return dead;

  const currentStartTimes = getProcessStartTimesBatch([...pidStartTimes.keys()]);

  for (const [pid, storedStartTime] of pidStartTimes) {
    const currentStartTime = currentStartTimes.get(pid);
    if (currentStartTime === undefined) {
      dead.add(pid); // process is gone
    } else if (Math.abs(currentStartTime - storedStartTime) > toleranceMs) {
      dead.add(pid); // PID recycled
    }
  }

  return dead;
}
