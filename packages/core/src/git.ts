/**
 * Git utilities shared across packages.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type SpawnResult, spawnCaptureSync } from "./subprocess";

/** Timeout for `git rev-parse` plumbing probes — should complete in milliseconds on any sane repo. */
export const GIT_REV_PARSE_TIMEOUT_MS = 5_000;

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export type ExecFn = (cmd: string[]) => ExecResult;

/**
 * Discriminated outcome of a git repo-root probe. Distinguishes the three
 * cases that {@link findGitRoot}/{@link findWorktreeRoot} historically all
 * collapsed into a single `null` (#2862):
 *
 * - `root` — a working-tree/git root was resolved (`path` is absolute).
 * - `not-a-repo` — `cwd` is genuinely outside any git repository. Falling back
 *   to `cwd` is correct here.
 * - `git-unavailable` — the probe could not be answered: git timed out
 *   (`reason: "timeout"`, the orphaned-load / CPU-starvation pattern) or the
 *   `git` process failed to spawn / was killed / exited abnormally
 *   (`reason: "spawn-failed"`). A cwd fallback here silently degrades root
 *   resolution and must NOT be treated as "not a repo".
 */
export type GitRootResult =
  | { kind: "root"; path: string }
  | { kind: "not-a-repo" }
  | { kind: "git-unavailable"; reason: "timeout" | "spawn-failed"; detail: string };

/** Injectable spawn seam so the *Result probes can be unit-tested without a real git. */
export type GitSpawnFn = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => SpawnResult;

/**
 * Classify a *failed* `git rev-parse` result as `git-unavailable`, or return
 * null when the non-zero exit is an ordinary "answered, just not here" result
 * (e.g. exit 128 outside a repo, or the bare-repo case where `--show-toplevel`
 * errors but `--git-common-dir` succeeds). Timeouts and spawn failures surface
 * `exitCode: null` / `timedOut: true` from {@link spawnCaptureSync}, so the
 * distinguishing signal is already available — it was previously discarded.
 */
function classifyUnavailable(r: SpawnResult): Extract<GitRootResult, { kind: "git-unavailable" }> | null {
  if (r.timedOut) {
    return {
      kind: "git-unavailable",
      reason: "timeout",
      detail: `git rev-parse timed out after ${GIT_REV_PARSE_TIMEOUT_MS}ms`,
    };
  }
  if (r.exitCode === null) {
    return {
      kind: "git-unavailable",
      reason: "spawn-failed",
      detail: r.signal ? `git killed by ${r.signal}` : "git binary not found or failed to spawn",
    };
  }
  return null;
}

/**
 * @deprecated Use {@link ensureCoreBareUnset} — it removes the key regardless
 * of value, eliminating the attack surface entirely. This function only reacts
 * to `core.bare=true` and ignores `false`. See #1860.
 */
export function fixCoreBare(cwd: string, exec: ExecFn): boolean {
  // Only touch non-bare repos — a legitimate bare repo has no .git directory.
  if (!existsSync(join(cwd, ".git"))) {
    return false;
  }

  const { stdout, exitCode } = exec(["git", "-C", cwd, "config", "core.bare"]);
  if (exitCode === 0 && stdout.trim() === "true") {
    // Unset the key entirely rather than setting to "false". Without the key,
    // git auto-detects bare status from the directory structure (.git dir = non-bare).
    // This prevents the recurrence where concurrent worktree operations flip an
    // existing "false" value back to "true". See #1206.
    const unset = exec(["git", "-C", cwd, "config", "--unset", "core.bare"]);
    return unset.exitCode === 0;
  }
  return false;
}

/**
 * Read-only probe: returns true when `core.bare` is set to "true" on the repo.
 * Used to instrument git ops — compare before/after to detect which operation
 * flipped the bit. See #1330.
 */
export function isCoreBareSet(cwd: string, exec: ExecFn): boolean {
  if (!existsSync(join(cwd, ".git"))) return false;
  const { stdout, exitCode } = exec(["git", "-C", cwd, "config", "core.bare"]);
  return exitCode === 0 && stdout.trim() === "true";
}

/** Discriminated result from {@link ensureCoreBareUnset}. */
export type CoreBareUnsetResult =
  /** Key was present and successfully removed (or was already gone via a benign race). */
  | "removed"
  /** Key was already absent — nothing to do. */
  | "absent"
  /** `--unset` failed and the key is still present; set to `false` as a last resort. */
  | "fallback";

/**
 * Remove the `core.bare` config key entirely, regardless of its current value.
 *
 * Git auto-detects bare status from the directory layout (.git dir = non-bare).
 * An explicit `core.bare = false` is harmless but creates a key that COULD be
 * flipped to `true` by an unknown external operation — the 47-sprint recurring
 * bug. Removing the key eliminates the attack surface: if the key doesn't exist,
 * nothing can flip it. See #1860.
 *
 * Returns a {@link CoreBareUnsetResult} discriminating three outcomes:
 * - `"removed"` — key was present and successfully removed (metric as a heal)
 * - `"absent"` — key was already absent, no-op
 * - `"fallback"` — `--unset` failed, key set to `false` as last resort (warn: structural fix incomplete)
 */
export function ensureCoreBareUnset(cwd: string, exec: ExecFn): CoreBareUnsetResult {
  if (!existsSync(join(cwd, ".git"))) return "absent";
  const { exitCode } = exec(["git", "-C", cwd, "config", "--local", "core.bare"]);
  if (exitCode !== 0) return "absent"; // key already absent
  const unset = exec(["git", "-C", cwd, "config", "--local", "--unset", "core.bare"]);
  if (unset.exitCode === 0) return "removed";
  // --unset failed. Re-read to distinguish "key gone (benign race)" from
  // "key still present (real failure)". Without this re-read the fallback
  // would recreate the key, defeating the structural fix.
  const recheck = exec(["git", "-C", cwd, "config", "--local", "core.bare"]);
  if (recheck.exitCode !== 0) return "removed"; // key gone — race resolved
  // Key stubbornly present (locked file, permission issue, etc.).
  // Last resort: ensure it's at least "false" so git ops don't break.
  if (recheck.stdout.trim() !== "false") {
    exec(["git", "-C", cwd, "config", "--local", "core.bare", "false"]);
  }
  return "fallback";
}

/**
 * Environment for git repo-discovery commands: strip inherited GIT_DIR,
 * GIT_WORK_TREE, and GIT_COMMON_DIR so that the caller's git-hook environment
 * does not override filesystem-based discovery. findGitRoot is meant to
 * discover repos by path, not by inherited git configuration.
 */
function gitDiscoverEnv(): Record<string, string | undefined> {
  // Strip inherited git-hook env vars so filesystem-based repo discovery works correctly
  // when findGitRoot is called from within a git hook (e.g. pre-commit).
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_COMMON_DIR: _c,
    GIT_INDEX_FILE: _i,
    GIT_OBJECT_DIRECTORY: _o,
    ...rest
  } = process.env;
  return rest;
}

/** Process-local cache: resolved cwd → git root result. */
const gitRootCache = new Map<string, GitRootResult>();

/** Clear the findGitRoot process-local cache. Intended for tests and long-lived processes that move worktrees. */
export function clearFindGitRootCache(): void {
  gitRootCache.clear();
}

/**
 * Pure core of {@link findGitRootResult} — no caching, injectable `spawn` so
 * the timeout / spawn-failure / not-a-repo branches can be unit-tested without
 * a real git. See {@link findGitRoot} for the resolution semantics.
 */
export function computeGitRootResult(cwd: string, spawn: GitSpawnFn = spawnCaptureSync): GitRootResult {
  // gitDiscoverEnv() strips hook-injected GIT_DIR/GIT_WORK_TREE vars so that
  // when findGitRoot runs from inside a git hook, filesystem-based discovery
  // isn't overridden by the hook's environment.
  const env = gitDiscoverEnv();
  const top = spawn("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
    env,
  });
  if (top.exitCode === 0) {
    const toplevel = top.stdout.trim();
    if (!toplevel) return { kind: "not-a-repo" };
    const gitDir = spawn("git", ["-C", cwd, "rev-parse", "--git-dir"], {
      timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
      env,
    });
    if (gitDir.exitCode === 0) {
      const gitDirStr = gitDir.stdout.trim();
      // Linked worktrees store their git-dir under .git/worktrees/<name>/,
      // so /worktrees/ in the path is the cheapest worktree signal.
      // Only fetch --git-common-dir when we're in a linked worktree.
      if (gitDirStr.includes("/worktrees/")) {
        const commonDir = spawn("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
          timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
          env,
        });
        if (commonDir.exitCode === 0) {
          const commonDirAbs = resolve(cwd, commonDir.stdout.trim());
          const path =
            commonDirAbs.endsWith("/.git") || commonDirAbs.endsWith(".git") ? dirname(commonDirAbs) : commonDirAbs;
          return { kind: "root", path };
        }
        return { kind: "root", path: toplevel };
      }
      return { kind: "root", path: toplevel };
    }
    return { kind: "root", path: toplevel };
  }

  // --show-toplevel failed. A timeout or spawn failure is `git-unavailable`
  // and must NOT be confused with "not a repo" (#2862). An ordinary non-zero
  // exit (128 outside a repo, or the bare-repo case) falls through to the
  // --git-common-dir probe below.
  const topUnavail = classifyUnavailable(top);
  if (topUnavail) return topUnavail;

  // Bare repo fallback — no working tree, use the common dir directly.
  const common = spawn("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
    env,
  });
  if (common.exitCode === 0) {
    const commonDir = common.stdout.trim();
    if (commonDir) return { kind: "root", path: resolve(cwd, commonDir) };
    return { kind: "not-a-repo" };
  }
  const commonUnavail = classifyUnavailable(common);
  if (commonUnavail) return commonUnavail;
  return { kind: "not-a-repo" };
}

/**
 * Like {@link findGitRoot} but returns a {@link GitRootResult} that
 * distinguishes "not a repo" from "git unavailable" (timeout / spawn failure).
 * Cached process-locally by cwd. Prefer this in blocking hook paths so a
 * degraded-git result can be surfaced as a warning rather than a misleading
 * hard failure (#2862).
 */
export function findGitRootResult(cwd: string = process.cwd()): GitRootResult {
  const cached = gitRootCache.get(cwd);
  if (cached) return cached;
  const result = computeGitRootResult(cwd);
  gitRootCache.set(cwd, result);
  return result;
}

/**
 * Resolve the git repository root from a working directory.
 * Returns an absolute path, or null if `cwd` is not inside a git repository
 * OR if git was unavailable (timeout / spawn failure). Callers that need to
 * distinguish those cases must use {@link findGitRootResult}.
 *
 * Prefers `--show-toplevel` (the working-tree root). For linked worktrees,
 * maps back to the main checkout's root via `--git-common-dir` so every
 * worktree of a repo shares one key. For bare repos, `--show-toplevel`
 * errors and we fall back to `--git-common-dir` as-is (no parent-dir strip,
 * which would have collapsed two bare repos in one directory).
 *
 * Common (non-worktree) case: 2 spawns (--show-toplevel + --git-dir).
 * Linked-worktree case: 3 spawns (+ --git-common-dir, triggered by /worktrees/ in git-dir).
 * Results are cached process-locally by cwd to eliminate repeated spawns.
 */
export function findGitRoot(cwd: string = process.cwd()): string | null {
  const r = findGitRootResult(cwd);
  return r.kind === "root" ? r.path : null;
}

/** Process-local cache: resolved cwd → worktree root result. */
const worktreeRootCache = new Map<string, GitRootResult>();

/** Clear the findWorktreeRoot process-local cache. Intended for tests and long-lived processes that move worktrees. */
export function clearFindWorktreeRootCache(): void {
  worktreeRootCache.clear();
}

/**
 * Pure core of {@link findWorktreeRootResult} — no caching, injectable `spawn`
 * so the timeout / spawn-failure / not-a-repo branches can be unit-tested
 * without a real git.
 */
export function computeWorktreeRootResult(cwd: string, spawn: GitSpawnFn = spawnCaptureSync): GitRootResult {
  const env = gitDiscoverEnv();
  const top = spawn("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
    env,
  });
  if (top.exitCode === 0) {
    const toplevel = top.stdout.trim();
    return toplevel ? { kind: "root", path: toplevel } : { kind: "not-a-repo" };
  }
  return classifyUnavailable(top) ?? { kind: "not-a-repo" };
}

/**
 * Like {@link findWorktreeRoot} but returns a {@link GitRootResult} that
 * distinguishes "not a repo" from "git unavailable" (timeout / spawn failure).
 * Cached process-locally by cwd. `mcx phase check` uses this so a degraded-git
 * result becomes a warning rather than a misleading `no .mcx.lock` (#2862).
 */
export function findWorktreeRootResult(cwd: string = process.cwd()): GitRootResult {
  const cached = worktreeRootCache.get(cwd);
  if (cached) return cached;
  const result = computeWorktreeRootResult(cwd);
  worktreeRootCache.set(cwd, result);
  return result;
}

/**
 * Resolve the working-tree root of `cwd` — the toplevel of *this* checkout,
 * NOT remapped to the main checkout for linked worktrees.
 *
 * Unlike {@link findGitRoot} (which maps linked worktrees back to the main
 * checkout via `--git-common-dir` so every worktree shares one key for daemon
 * state), this returns the worktree's own `--show-toplevel`. Use it for
 * per-checkout working-tree files — `.mcx.lock`, `.mcx.yaml`, phase sources —
 * that each linked worktree owns its own copy of. Resolving those from the
 * main checkout makes `phase check`/`install` operate on the wrong tree from a
 * worktree. See #2737 (distinct from #2673, which keys runtime *state*).
 *
 * Returns null when `cwd` is not inside a git repository OR git was unavailable
 * (timeout / spawn failure). Callers that must distinguish those cases use
 * {@link findWorktreeRootResult}. Results are cached process-locally by cwd.
 */
export function findWorktreeRoot(cwd: string = process.cwd()): string | null {
  const r = findWorktreeRootResult(cwd);
  return r.kind === "root" ? r.path : null;
}
