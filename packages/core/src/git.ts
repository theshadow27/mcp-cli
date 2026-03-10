/**
 * Git utilities shared across packages.
 */

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
  const { stdout, exitCode } = exec(["git", "-C", cwd, "config", "core.bare"]);
  if (exitCode === 0 && stdout.trim() === "true") {
    exec(["git", "-C", cwd, "config", "core.bare", "false"]);
    return true;
  }
  return false;
}
