/**
 * Staged-file detection for selective test runs.
 *
 * Determines whether run-2 (daemon tests) can be skipped based on which
 * files are staged for commit. If no staged files touch daemon-related
 * paths, run-2 is unnecessary and can be safely skipped to avoid timeout
 * issues in worktree environments (see #1085).
 */

/**
 * Path prefixes that require run-2 (daemon tests) when staged.
 *
 * - packages/daemon/ — daemon source and tests
 * - packages/core/   — shared infrastructure imported by daemon
 * - test/            — top-level integration tests (run-2 test files live here)
 * - scripts/check-coverage.ts — the coverage script itself (changes could affect run-2)
 */
const RUN2_TRIGGER_PREFIXES = ["packages/daemon/", "packages/core/", "test/", "scripts/check-coverage.ts"] as const;

/**
 * Check whether any staged files require daemon tests (run-2) to execute.
 *
 * @param stagedFiles - list of staged file paths (relative to repo root)
 * @returns true if run-2 should be skipped (no daemon-related files staged)
 */
export function shouldSkipRun2(stagedFiles: string[]): boolean {
  if (stagedFiles.length === 0) return false; // no staged files = full run (safety default)
  return !stagedFiles.some((f) => RUN2_TRIGGER_PREFIXES.some((prefix) => f.startsWith(prefix)));
}

/**
 * Get the list of staged files from git.
 * Returns empty array if not in a git repo or no files are staged.
 */
export async function getStagedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--cached", "--name-only", "--diff-filter=d"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return [];
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}
