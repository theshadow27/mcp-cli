/**
 * Pure restart/backoff policy — extracted from ClaudeServer so it can be
 * unit-tested without spawning real Worker threads.
 */

export interface RestartPolicy {
  /** Maximum number of crashes allowed within the window before giving up. */
  maxCrashes: number;
  /** Rolling window (ms) for counting crashes. */
  crashWindowMs: number;
  /** Backoff delays (ms) for retry attempts 1, 2, 3, …  Attempt 0 has no delay. */
  backoffDelaysMs: readonly number[];
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxCrashes: 3,
  crashWindowMs: 60_000,
  backoffDelaysMs: [100, 500, 2000],
};

/**
 * Record a crash and decide whether a restart should be attempted.
 *
 * Mutates `crashTimestamps` by appending `now` and trimming entries
 * that fall outside the rolling window.
 *
 * @returns `true` if the crash budget has not been exceeded (restart OK).
 */
export function shouldRestart(crashTimestamps: number[], policy: RestartPolicy, now: number = Date.now()): boolean {
  crashTimestamps.push(now);
  // Trim timestamps outside the window
  while (crashTimestamps.length > 0 && (crashTimestamps[0] ?? 0) <= now - policy.crashWindowMs) {
    crashTimestamps.shift();
  }
  return crashTimestamps.length <= policy.maxCrashes;
}

/**
 * Get the backoff delay for a given retry attempt (0-indexed).
 * Attempt 0 = no delay (first try).
 * Attempt 1+ = backoff from schedule, clamped to the last entry.
 */
export function getBackoffDelay(attempt: number, backoffDelaysMs: readonly number[]): number {
  if (attempt <= 0) return 0;
  return backoffDelaysMs[attempt - 1] ?? backoffDelaysMs.at(-1) ?? 2000;
}

/** Total number of start() attempts (initial + retries). */
export function maxAttempts(policy: RestartPolicy): number {
  return policy.backoffDelaysMs.length + 1;
}
