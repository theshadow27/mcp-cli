/**
 * Resolve a PR number to its head branch name via `gh pr view`.
 *
 * Used by WorkItemsServer to auto-populate `branch` on a work item when
 * only `prNumber` is known (see #1424). Four safety guarantees:
 *
 * 1. **Timeout**: the gh subprocess is killed after `timeoutMs` (default 5s)
 *    so a daemon IPC slot can't hang on an interactive auth prompt.
 * 2. **Explicit repo**: `--repo owner/repo` is always passed so the lookup
 *    is never ambiguous on the daemon's cwd (which may differ from the
 *    work item's repo).
 * 3. **Both streams drained**: stdout and stderr are consumed concurrently
 *    so a chatty gh can't block on pipe backpressure.
 * 4. **Best-effort**: any failure — spawn throws, non-zero exit, timeout,
 *    empty stdout — returns null. Callers treat null as "branch not known"
 *    and continue.
 */
import type { Logger } from "@mcp-cli/core";
import type { RepoInfo } from "./graphql-client";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ResolveBranchOptions {
  repo: RepoInfo;
  timeoutMs?: number;
  /** Injected for tests — defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** Optional logger — stderr from failed gh calls is forwarded at debug level. */
  logger?: Logger;
}

export async function resolveBranchFromPr(prNumber: number, opts: ResolveBranchOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = opts.spawn ?? Bun.spawn;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawn(
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
  } catch (err) {
    // `gh` not installed, ENOMEM, EMFILE, etc. Best-effort contract:
    // spawn failure is indistinguishable from "branch not known".
    opts.logger?.debug?.(`[resolve-branch] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // Already exited — ignore.
    }
  }, timeoutMs);

  try {
    // Drain both streams concurrently with `exited`. Leaving stderr un-read
    // can stall gh on pipe backpressure if it emits enough warnings.
    const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
    const stderrPromise = new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    if (exitCode !== 0) {
      if (stderr.trim().length > 0) {
        opts.logger?.debug?.(`[resolve-branch] gh exit ${exitCode}: ${stderr.trim()}`);
      }
      return null;
    }
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } finally {
    clearTimeout(timer);
  }
}
