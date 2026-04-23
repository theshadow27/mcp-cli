/**
 * Shared worktrees subcommand handler for all providers.
 *
 * Provides `worktrees` (list) and `worktrees --prune` functionality
 * that any provider can add to its command dispatch.
 */

import { IPC_ERROR, IpcCallError, WorktreeError, listMcxWorktrees, pruneWorktrees } from "@mcp-cli/core";
import type { WorktreeShimDeps } from "@mcp-cli/core";
import { c, formatToolResult } from "../output";

/** Shared dependency interface for session-based commands. */
export interface WorktreeCommandDeps extends WorktreeShimDeps {
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  exit: (code: number) => never;
}

/** All provider session list tools — prune must check ALL providers. */
const ALL_SESSION_LIST_TOOLS = [
  "claude_session_list",
  "codex_session_list",
  "acp_session_list",
  "opencode_session_list",
];

/**
 * Get the set of worktree names with active sessions across ALL providers.
 * For display/list operations: returns empty set on daemon failure (fail-open).
 * For prune operations: throws on daemon failure (fail-closed).
 */
export async function getAllActiveSessionWorktrees(
  deps: WorktreeCommandDeps,
  failClosed: boolean,
): Promise<Set<string>> {
  const combined = new Set<string>();
  for (const tool of ALL_SESSION_LIST_TOOLS) {
    try {
      const result = await deps.callTool(tool, {});
      const text = formatToolResult(result);
      const sessions = JSON.parse(text) as Array<{ worktree?: string | null }>;
      for (const s of sessions) {
        if (s.worktree) combined.add(s.worktree);
      }
    } catch (e) {
      if (e instanceof IpcCallError) {
        // Skip when the provider server is absent or disconnected — it can't
        // have active sessions, so skipping is safe.  Re-throw for logic
        // errors (invalid-params, internal, etc.) that indicate a real
        // problem with the call itself.
        //
        // Primary: structured error code from the daemon (SERVER_NOT_FOUND).
        // Fallback: substring match for older daemons that don't set the code.
        if (e.code === IPC_ERROR.SERVER_NOT_FOUND) continue;
        const msg = e.message.toLowerCase();
        if (
          (msg.includes("server") && msg.includes("not found")) ||
          msg.includes("not connected") ||
          msg.includes("disconnected") ||
          msg.includes("not reachable") ||
          msg.includes("unreachable")
        ) {
          continue;
        }
        throw e;
      }
      if (failClosed) {
        throw new Error(`Cannot reach daemon to query ${tool}. Aborting prune to prevent destroying active worktrees.`);
      }
      // fail-open for list/display — continue with what we have
    }
  }
  return combined;
}

/**
 * Shared worktrees subcommand: list or prune mcx-created worktrees.
 *
 * @param args - CLI arguments after the `worktrees` subcommand
 * @param deps - Shared deps (must satisfy both WorktreeCommandDeps and WorktreeShimDeps)
 */
export async function worktreesCommand(args: string[], deps: WorktreeCommandDeps): Promise<void> {
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
    return deps.exit(1);
  }

  if (mcxWorktrees.length === 0 && !prune) {
    deps.printError("No mcx worktrees found.");
    return;
  }

  let activeWorktrees: Set<string>;
  try {
    activeWorktrees = await getAllActiveSessionWorktrees(deps, prune);
  } catch (e) {
    deps.printError(e instanceof Error ? e.message : String(e));
    return deps.exit(1);
  }

  if (prune) {
    const result = await pruneWorktrees({ repoRoot: cwd, activeWorktrees, deps });
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
    } else if (status.trim() === "") {
      wtStatus = `${c.green}${"clean".padEnd(10)}${c.reset}`;
    } else {
      wtStatus = `${c.yellow}${"dirty".padEnd(10)}${c.reset}`;
    }

    const session = hasSession ? `${c.green}active${c.reset}` : `${c.dim}—${c.reset}`;
    console.log(`${c.cyan}${wtName.padEnd(28)}${c.reset} ${branch} ${wtStatus} ${session}`);
  }
}
