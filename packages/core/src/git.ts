/**
 * Git utilities shared across packages.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnCaptureSync } from "./subprocess";

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export type ExecFn = (cmd: string[]) => ExecResult;

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

/** Process-local cache: resolved cwd → git root (null = not a git repo). */
const gitRootCache = new Map<string, string | null>();

/** Clear the findGitRoot process-local cache. Intended for tests and long-lived processes that move worktrees. */
export function clearFindGitRootCache(): void {
  gitRootCache.clear();
}

/**
 * Resolve the git repository root from a working directory.
 * Returns an absolute path, or null if `cwd` is not inside a git repository.
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
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd) as string | null;

  // Note: gitDiscoverEnv() strips hook-injected GIT_DIR/GIT_WORK_TREE vars, but
  // spawnCaptureSync does not accept a custom env. In practice this function is
  // called outside of git hooks, so inheriting process.env is safe.
  let result: string | null = null;
  try {
    const top = spawnCaptureSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5000,
    });
    if (top.exitCode === 0) {
      const toplevel = top.stdout.trim();
      if (!toplevel) {
        gitRootCache.set(cwd, null);
        return null;
      }
      const gitDir = spawnCaptureSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
        timeoutMs: 5000,
      });
      if (gitDir.exitCode === 0) {
        const gitDirStr = gitDir.stdout.trim();
        // Linked worktrees store their git-dir under .git/worktrees/<name>/,
        // so /worktrees/ in the path is the cheapest worktree signal.
        // Only fetch --git-common-dir when we're in a linked worktree.
        if (gitDirStr.includes("/worktrees/")) {
          const commonDir = spawnCaptureSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
            timeoutMs: 5000,
          });
          if (commonDir.exitCode === 0) {
            const commonDirAbs = resolve(cwd, commonDir.stdout.trim());
            result =
              commonDirAbs.endsWith("/.git") || commonDirAbs.endsWith(".git") ? dirname(commonDirAbs) : commonDirAbs;
          } else {
            result = toplevel;
          }
        } else {
          result = toplevel;
        }
      } else {
        result = toplevel;
      }
    } else {
      // Bare repo fallback — no working tree, use the common dir directly.
      const common = spawnCaptureSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
        timeoutMs: 5000,
      });
      if (common.exitCode === 0) {
        const commonDir = common.stdout.trim();
        if (commonDir) result = resolve(cwd, commonDir);
      }
    }
  } catch {
    // result stays null
  }

  gitRootCache.set(cwd, result);
  return result;
}
