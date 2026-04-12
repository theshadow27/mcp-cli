/**
 * Git utilities shared across packages.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export type ExecFn = (cmd: string[]) => ExecResult;

/**
 * After `git worktree remove`, git can sometimes flip `core.bare = true`
 * on the main repository (especially under heavy concurrent worktree
 * create/remove cycles). This breaks all subsequent git operations.
 *
 * Call this after every successful `git worktree remove` to detect and
 * fix the issue. See https://github.com/theshadow27/mcp-cli/issues/394
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
 * Resolve the git repository root from a working directory.
 * Returns an absolute path, or null if `cwd` is not inside a git repository.
 *
 * Prefers `--show-toplevel` (the working-tree root). For linked worktrees,
 * maps back to the main checkout's root via `--git-common-dir` so every
 * worktree of a repo shares one key. For bare repos, `--show-toplevel`
 * errors and we fall back to `--git-common-dir` as-is (no parent-dir strip,
 * which would have collapsed two bare repos in one directory).
 */
export function findGitRoot(cwd: string = process.cwd()): string | null {
  try {
    const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (top.exitCode === 0) {
      const toplevel = top.stdout.toString().trim();
      if (!toplevel) return null;
      const gitDir = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--git-dir"], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 5000,
      });
      const commonDir = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 5000,
      });
      if (gitDir.exitCode === 0 && commonDir.exitCode === 0) {
        const gitDirAbs = resolve(cwd, gitDir.stdout.toString().trim());
        const commonDirAbs = resolve(cwd, commonDir.stdout.toString().trim());
        if (gitDirAbs !== commonDirAbs) {
          return commonDirAbs.endsWith("/.git") || commonDirAbs.endsWith(".git") ? dirname(commonDirAbs) : commonDirAbs;
        }
      }
      return toplevel;
    }
    // Bare repo fallback — no working tree, use the common dir directly.
    const common = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (common.exitCode !== 0) return null;
    const commonDir = common.stdout.toString().trim();
    if (!commonDir) return null;
    return resolve(cwd, commonDir);
  } catch {
    return null;
  }
}
