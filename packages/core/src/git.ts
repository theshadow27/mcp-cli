/**
 * Git utilities shared across packages.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

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
