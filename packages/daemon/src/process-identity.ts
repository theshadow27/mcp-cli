/**
 * Process identity verification — prevents PID reuse from causing
 * SIGTERM to wrong processes or ghost sessions.
 *
 * Uses `ps -o lstart=` to get a process's start time, which is stable
 * across queries and changes when a PID is recycled.
 */

/**
 * Get the start time (epoch ms) of a process by PID.
 * Returns null if the process doesn't exist or the start time can't be determined.
 */
export function getProcessStartTime(pid: number): number | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    if (!output) return null;
    const ms = new Date(output).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
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
