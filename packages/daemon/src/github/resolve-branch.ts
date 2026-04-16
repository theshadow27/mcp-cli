/**
 * Resolve a PR number to its head branch name via `gh pr view`.
 *
 * Used by WorkItemsServer to auto-populate `branch` on a work item when
 * only `prNumber` is known (see #1424). Three safety guarantees:
 *
 * 1. **Timeout**: the gh subprocess is killed after `timeoutMs` (default 5s)
 *    so a daemon IPC slot can't hang on an interactive auth prompt.
 * 2. **Explicit repo**: `--repo owner/repo` is always passed so the lookup
 *    is never ambiguous on the daemon's cwd (which may differ from the
 *    work item's repo).
 * 3. **Best-effort**: any failure — non-zero exit, timeout, empty stdout —
 *    returns null. Callers treat null as "branch not known" and continue.
 */
import type { RepoInfo } from "./graphql-client";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ResolveBranchOptions {
  repo: RepoInfo;
  timeoutMs?: number;
  /** Injected for tests — defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn;
}

export async function resolveBranchFromPr(prNumber: number, opts: ResolveBranchOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = opts.spawn ?? Bun.spawn;
  const proc = spawn(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${opts.repo.owner}/${opts.repo.repo}`,
      "--json",
      "headRefName",
      "-q",
      ".headRefName",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // Already exited — ignore.
    }
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } finally {
    clearTimeout(timer);
  }
}
