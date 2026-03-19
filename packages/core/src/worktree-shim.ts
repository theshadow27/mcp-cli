/**
 * Worktree lifecycle shim — generic worktree management for all providers.
 *
 * Handles worktree creation, cleanup, listing, and pruning in a provider-neutral way.
 * Providers that handle worktrees natively (e.g., Claude) can skip the shim;
 * others (Codex, ACP, OpenCode) get worktree support via cwd passthrough.
 *
 * @see https://github.com/theshadow27/mcp-cli/issues/909
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn } from "./git";
import { fixCoreBare } from "./git";
import {
  buildHookEnv,
  hasWorktreeHooks,
  readWorktreeConfig,
  resolveWorktreeBase,
  resolveWorktreePath,
} from "./worktree-config";

// ── Types ──

/** Minimal dependency interface for worktree operations. */
export interface WorktreeShimDeps {
  exec: (
    cmd: string[],
    opts?: { env?: Record<string, string> },
  ) => { stdout: string; stderr: string; exitCode: number };
  printError: (msg: string) => void;
}

/** Result of worktree creation — fields to merge into tool call arguments. */
export interface WorktreeCreateResult {
  /** The resolved worktree directory path. */
  path: string;
  /** Tool arg overrides to apply (cwd, worktree name, repoRoot). */
  toolArgs: Record<string, unknown>;
  /** Whether the shim handled creation (false = provider handles natively). */
  shimmed: boolean;
}

/** Options for creating a worktree. */
export interface WorktreeCreateOptions {
  /** Worktree name (branch slug). */
  name: string;
  /** Git repo root (defaults to process.cwd()). */
  repoRoot: string;
  /** Branch name prefix for non-hook creation (e.g., "codex/", "claude/"). If undefined, uses name as-is. */
  branchPrefix?: string;
  /** Whether the provider handles --worktree natively (skips shim creation). */
  nativeWorktree?: boolean;
}

/** A parsed worktree entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Options for pruning worktrees. */
export interface WorktreePruneOptions {
  repoRoot: string;
  /** Set of worktree names that have active sessions (skip these). */
  activeWorktrees: Set<string>;
  deps: WorktreeShimDeps;
}

/** Result of a prune operation. */
export interface WorktreePruneResult {
  pruned: number;
  skippedUnmerged: string[];
}

// ── Create ──

/**
 * Create a worktree for a provider session.
 *
 * Handles three cases:
 * 1. Custom hooks configured → run setup hook
 * 2. branchPrefix: false → create with raw branch name
 * 3. Provider has native worktree → pass through (no shim creation)
 * 4. Default → shim creates worktree with prefixed branch name
 *
 * Returns tool arg overrides and the resolved worktree path.
 */
export function createWorktree(opts: WorktreeCreateOptions, deps: WorktreeShimDeps): WorktreeCreateResult {
  const { name, repoRoot, branchPrefix, nativeWorktree } = opts;
  const wtConfig = readWorktreeConfig(repoRoot);

  // Path traversal guard — validate before any case
  const worktreeBase = resolveWorktreeBase(repoRoot, wtConfig);
  const candidatePath = resolveWorktreePath(repoRoot, name, wtConfig);
  if (!candidatePath.startsWith(`${worktreeBase}/`)) {
    throw new WorktreeError(`Worktree name "${name}" resolves outside the worktree base directory`);
  }

  // Case 1: Custom hooks
  if (hasWorktreeHooks(wtConfig)) {
    const worktreePath = resolveWorktreePath(repoRoot, name, wtConfig);
    const hookEnv = buildHookEnv({ branch: name, path: worktreePath, cwd: repoRoot });
    const { exitCode, stderr } = deps.exec(["sh", "-c", wtConfig.setup], { env: hookEnv });
    if (exitCode !== 0) {
      throw new WorktreeError(`Worktree setup hook failed: ${stderr}`);
    }
    if (!existsSync(worktreePath)) {
      throw new WorktreeError(`Worktree setup hook succeeded but directory does not exist: ${worktreePath}`);
    }
    deps.printError(`Created worktree via hook: ${worktreePath}`);
    return {
      path: worktreePath,
      toolArgs: { cwd: worktreePath, worktree: name, repoRoot },
      shimmed: true,
    };
  }

  // Case 2: branchPrefix: false — create with raw branch name
  if (wtConfig?.branchPrefix === false) {
    const worktreePath = resolveWorktreePath(repoRoot, name, wtConfig);
    const { exitCode, stderr } = deps.exec(["git", "worktree", "add", worktreePath, "-b", name, "HEAD"]);
    if (exitCode !== 0) {
      throw new WorktreeError(`Failed to create worktree: ${stderr}`);
    }
    deps.printError(`Created worktree: ${worktreePath}`);
    return {
      path: worktreePath,
      toolArgs: { cwd: worktreePath, worktree: name, repoRoot },
      shimmed: true,
    };
  }

  // Case 3: Provider handles --worktree natively (e.g., Claude headless without hooks)
  if (nativeWorktree) {
    return {
      path: resolveWorktreePath(repoRoot, name, wtConfig),
      toolArgs: { worktree: name },
      shimmed: false,
    };
  }

  // Case 4: Shim creates worktree with prefixed branch name
  const worktreePath = resolveWorktreePath(repoRoot, name, wtConfig);
  const gitBranch = branchPrefix ? `${branchPrefix}${name}` : name;
  const { exitCode, stderr } = deps.exec(["git", "worktree", "add", worktreePath, "-b", gitBranch, "HEAD"]);
  if (exitCode !== 0) {
    throw new WorktreeError(`Failed to create worktree: ${stderr}`);
  }
  deps.printError(`Created worktree: ${worktreePath}`);
  return {
    path: worktreePath,
    toolArgs: { cwd: worktreePath, worktree: name, repoRoot },
    shimmed: true,
  };
}

// ── Cleanup ──

/** Clean up a worktree after session ends: remove if clean, warn if dirty. */
export function cleanupWorktree(worktree: string, cwd: string, deps: WorktreeShimDeps, repoRoot?: string | null): void {
  const effectiveRoot = repoRoot ?? cwd;
  const wtConfig = readWorktreeConfig(effectiveRoot);
  const worktreeBase = resolveWorktreeBase(effectiveRoot, wtConfig);
  const worktreePath = join(worktreeBase, worktree);

  // Guard against path traversal
  if (!worktreePath.startsWith(`${worktreeBase}/`)) return;

  // Check for uncommitted changes (trim to handle trailing newline from some git versions)
  const { stdout: rawStatus, exitCode: statusExit } = deps.exec(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (statusExit !== 0) return;
  const status = rawStatus.trim();

  if (status === "") {
    // Capture branch name before removal (trim trailing newline from git output)
    const { stdout: rawBranch } = deps.exec(["git", "-C", worktreePath, "branch", "--show-current"]);
    const branch = rawBranch.trim();

    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      const hookEnv = buildHookEnv({ branch: worktree, path: worktreePath, cwd: effectiveRoot });
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (hookExit === 0) {
        deps.printError(`Removed worktree via hook: ${worktreePath}`);
        deleteIfMerged(branch, effectiveRoot, deps);
      } else {
        deps.printError(`Worktree teardown hook failed for: ${worktreePath}: ${hookStderr}`);
      }
    } else {
      const { exitCode: removeExit } = deps.exec(["git", "-C", effectiveRoot, "worktree", "remove", worktreePath]);
      if (removeExit === 0) {
        if (fixCoreBare(effectiveRoot, (cmd) => deps.exec(cmd))) {
          deps.printError("Fixed core.bare=true after worktree removal");
        }
        deps.printError(`Removed worktree: ${worktreePath}`);
        deleteIfMerged(branch, effectiveRoot, deps);
      } else {
        deps.printError(`Failed to remove worktree: ${worktreePath}`);
      }
    }
  } else {
    // Dirty — warn
    const lines = status.split("\n").filter((l) => l !== "");
    const modified = lines.filter((l) => l[0] === "M" || l[1] === "M").length;
    const untracked = lines.filter((l) => l.startsWith("??")).length;
    const other = lines.length - modified - untracked;

    const parts: string[] = [];
    if (modified > 0) parts.push(`${modified} modified`);
    if (untracked > 0) parts.push(`${untracked} untracked`);
    if (other > 0) parts.push(`${other} other`);

    deps.printError("Warning: worktree has uncommitted changes, not removing:");
    deps.printError(`  ${worktreePath}`);
    deps.printError(`  ${parts.join(", ")}`);
  }
}

/** Delete a branch if it's been merged (git branch -d is safe — refuses unmerged). */
function deleteIfMerged(branch: string, repoRoot: string, deps: WorktreeShimDeps): void {
  if (!branch) return;
  const { exitCode } = deps.exec(["git", "-C", repoRoot, "branch", "-d", branch]);
  if (exitCode === 0) {
    deps.printError(`Deleted branch: ${branch} (merged)`);
  }
}

// ── List ──

/** Parse `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath) entries.push({ path: currentPath, branch: currentBranch });
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    }
  }
  if (currentPath) entries.push({ path: currentPath, branch: currentBranch });
  return entries;
}

/**
 * List mcx-managed worktrees under the worktree base directory.
 * Returns all worktrees whose path starts with the resolved base.
 */
export function listMcxWorktrees(
  repoRoot: string,
  deps: WorktreeShimDeps,
): { worktrees: WorktreeEntry[]; allWorktrees: WorktreeEntry[]; worktreeBase: string } {
  const wtConfig = readWorktreeConfig(repoRoot);
  const worktreeBase = resolveWorktreeBase(repoRoot, wtConfig);

  const { stdout, exitCode } = deps.exec(["git", "-C", repoRoot, "worktree", "list", "--porcelain"]);
  if (exitCode !== 0) {
    throw new WorktreeError("Failed to list git worktrees (not a git repo?)");
  }

  const allWorktrees = parseWorktreeList(stdout);
  const mcx = allWorktrees.filter((wt) => wt.path.startsWith(`${worktreeBase}/`));
  return { worktrees: mcx, allWorktrees, worktreeBase };
}

// ── Prune ──

/**
 * Detect the default branch (e.g. "main" or "master") from origin/HEAD.
 */
export function getDefaultBranch(deps: WorktreeShimDeps, cwd: string): string {
  const { stdout, exitCode } = deps.exec(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (exitCode === 0 && stdout.trim()) {
    const parts = stdout.trim().split("/");
    return parts[parts.length - 1] || "main";
  }
  return "main";
}

/**
 * Prune clean, merged, orphaned worktrees.
 * Skips worktrees with active sessions and unmerged branches.
 */
export function pruneWorktrees(opts: WorktreePruneOptions): WorktreePruneResult {
  const { repoRoot, activeWorktrees, deps } = opts;
  const wtConfig = readWorktreeConfig(repoRoot);
  const { worktrees, worktreeBase } = listMcxWorktrees(repoRoot, deps);

  const defaultBranch = getDefaultBranch(deps, repoRoot);
  const { stdout: mergedOutput, exitCode: mergedExit } = deps.exec([
    "git",
    "-C",
    repoRoot,
    "branch",
    "--merged",
    defaultBranch,
  ]);

  let mergedBranches: Set<string>;
  let skipMergeCheck = false;
  if (mergedExit !== 0) {
    deps.printError(
      "Warning: could not determine merged branches (git branch --merged failed). Pruning clean orphaned worktrees without merge check.",
    );
    mergedBranches = new Set();
    skipMergeCheck = true;
  } else {
    mergedBranches = new Set(
      mergedOutput
        .split("\n")
        .map((line) => line.replace(/^\*?\s+/, "").trim())
        .filter(Boolean),
    );
  }

  let pruned = 0;
  const skippedUnmerged: string[] = [];

  for (const wt of worktrees) {
    const wtName = wt.path.slice(`${worktreeBase}/`.length);
    if (activeWorktrees.has(wtName)) continue;
    if (!skipMergeCheck && wt.branch && !mergedBranches.has(wt.branch)) {
      skippedUnmerged.push(wt.branch);
      continue;
    }

    // Check if clean (trim to handle trailing newline from some git versions)
    const { stdout: status, exitCode: statusExit } = deps.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    if (statusExit !== 0 || status.trim() !== "") continue;

    // Remove worktree
    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      const hookEnv = buildHookEnv({ branch: wtName, path: wt.path, cwd: repoRoot });
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (hookExit === 0) {
        deps.printError(`Removed worktree via hook: ${wt.path}`);
        pruned++;
        deleteIfMerged(wt.branch ?? "", repoRoot, deps);
      } else {
        deps.printError(`Worktree teardown hook failed for: ${wt.path}: ${hookStderr}`);
      }
    } else {
      const { exitCode: removeExit } = deps.exec(["git", "-C", repoRoot, "worktree", "remove", wt.path]);
      if (removeExit === 0) {
        if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
          deps.printError("Fixed core.bare=true after worktree removal");
        }
        deps.printError(`Removed worktree: ${wt.path}`);
        pruned++;
        deleteIfMerged(wt.branch ?? "", repoRoot, deps);
      }
    }
  }

  return { pruned, skippedUnmerged };
}

// ── Errors ──

/** Typed error for worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
