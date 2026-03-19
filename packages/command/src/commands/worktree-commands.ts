/**
 * Shared worktrees subcommand handler for all providers.
 *
 * Provides `worktrees` (list) and `worktrees --prune` functionality
 * that any provider can add to its command dispatch.
 */

import { WorktreeError, listMcxWorktrees, pruneWorktrees } from "@mcp-cli/core";
import type { WorktreeShimDeps } from "@mcp-cli/core";
import { c } from "../output";
import { getActiveSessionWorktrees } from "./claude";
import type { SharedSessionDeps } from "./claude";

/**
 * Shared worktrees subcommand: list or prune mcx-created worktrees.
 *
 * @param args - CLI arguments after the `worktrees` subcommand
 * @param sessionListTool - The provider's session list tool name (e.g. `codex_session_list`)
 * @param deps - Shared session deps (must satisfy both SharedSessionDeps and WorktreeShimDeps)
 */
export async function worktreesCommand(
  args: string[],
  sessionListTool: string,
  deps: SharedSessionDeps & WorktreeShimDeps,
): Promise<void> {
  const prune = args.includes("--prune");
  const cwd = process.cwd();

  let mcxWorktrees: ReturnType<typeof listMcxWorktrees>["worktrees"];
  let worktreeBase: string;
  try {
    const listed = listMcxWorktrees(cwd, deps);
    mcxWorktrees = listed.worktrees;
    worktreeBase = listed.worktreeBase;
  } catch (e) {
    deps.printError(e instanceof WorktreeError ? e.message : String(e));
    deps.exit(1);
  }

  if (mcxWorktrees.length === 0 && !prune) {
    deps.printError("No mcx worktrees found.");
    return;
  }

  const activeWorktrees = await getActiveSessionWorktrees(sessionListTool, deps);

  if (prune) {
    const result = pruneWorktrees({ repoRoot: cwd, activeWorktrees, deps });
    if (result.pruned === 0) {
      deps.printError("Nothing to prune.");
    } else {
      deps.printError(`Pruned ${result.pruned} worktree${result.pruned === 1 ? "" : "s"}.`);
    }
    if (result.skippedUnmerged.length > 0) {
      deps.printError(`Skipped ${result.skippedUnmerged.length} unmerged: ${result.skippedUnmerged.join(", ")}`);
    }
    return;
  }

  // List mode — display table
  const header = `${"WORKTREE".padEnd(28)} ${"BRANCH".padEnd(32)} ${"STATUS".padEnd(10)} SESSION`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (const wt of mcxWorktrees) {
    const wtName = wt.path.slice(`${worktreeBase}/`.length);
    const branch = (wt.branch ?? "—").padEnd(32);
    const hasSession = activeWorktrees.has(wtName);

    const { stdout: status, exitCode: statusExit } = deps.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    let wtStatus: string;
    if (statusExit !== 0) {
      wtStatus = `${c.red}${"gone".padEnd(10)}${c.reset}`;
    } else if (status === "") {
      wtStatus = `${c.green}${"clean".padEnd(10)}${c.reset}`;
    } else {
      wtStatus = `${c.yellow}${"dirty".padEnd(10)}${c.reset}`;
    }

    const session = hasSession ? `${c.green}active${c.reset}` : `${c.dim}—${c.reset}`;
    console.log(`${c.cyan}${wtName.padEnd(28)}${c.reset} ${branch} ${wtStatus} ${session}`);
  }
}
