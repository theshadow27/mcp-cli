/**
 * Worktree lifecycle shim — generic worktree management for all providers.
 *
 * Handles worktree creation, cleanup, listing, and pruning in a provider-neutral way.
 * Providers that handle worktrees natively (e.g., Claude) can skip the shim;
 * others (Codex, ACP, OpenCode) get worktree support via cwd passthrough.
 *
 * @see https://github.com/theshadow27/mcp-cli/issues/909
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn } from "./git";
import { fixCoreBare, isCoreBareSet } from "./git";
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
  /** Print an informational status message (no "Error:" prefix). Used for successful operations. */
  printInfo: (msg: string) => void;
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
  /** If true, compute candidates but don't execute removals or branch deletes. */
  dryRun?: boolean;
  /**
   * Optional async refresh of active-session set, called before each removal.
   * Mitigates TOCTOU: orchestrator spawning a session into a candidate between
   * list and remove. Callers without a way to refresh may omit.
   */
  refreshActive?: () => Promise<Set<string>>;
}

/** Result of a prune operation. */
export interface WorktreePruneResult {
  /** Count of worktrees actually removed (0 in dry-run). */
  pruned: number;
  /** Names of worktrees that would be or were removed. */
  removable: string[];
  skippedUnmerged: string[];
  /** Branches that were deleted (empty in dry-run). */
  deletedBranches: Set<string>;
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
    deps.printInfo(`Created worktree via hook: ${worktreePath}`);
    return {
      path: worktreePath,
      toolArgs: { cwd: worktreePath, worktree: name, repoRoot },
      shimmed: true,
    };
  }

  // Case 2: branchPrefix: false — create with raw branch name
  if (wtConfig?.branchPrefix === false) {
    const worktreePath = resolveWorktreePath(repoRoot, name, wtConfig);
    const bareBeforeAdd2 = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
    const { exitCode, stderr } = deps.exec(["git", "worktree", "add", worktreePath, "-b", name, "HEAD"]);
    if (exitCode !== 0) {
      throw new WorktreeError(`Failed to create worktree: ${stderr}`);
    }
    if (!bareBeforeAdd2 && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError(
        `[shim] core.bare flipped to true by: git worktree add ${worktreePath} (repo=${repoRoot}) — see #1330`,
      );
    }
    if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError("Fixed core.bare=true after worktree add");
    }
    deps.printInfo(`Created worktree: ${worktreePath}`);
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
  const bareBeforeAdd4 = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode, stderr } = deps.exec(["git", "worktree", "add", worktreePath, "-b", gitBranch, "HEAD"]);
  if (exitCode !== 0) {
    throw new WorktreeError(`Failed to create worktree: ${stderr}`);
  }
  if (!bareBeforeAdd4 && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError(
      `[shim] core.bare flipped to true by: git worktree add ${worktreePath} (repo=${repoRoot}) — see #1330`,
    );
  }
  if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError("Fixed core.bare=true after worktree add");
  }
  deps.printInfo(`Created worktree: ${worktreePath}`);
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
  if (statusExit !== 0) {
    // git status failed — worktree may be corrupted or partially removed.
    // Attempt removal anyway rather than silently leaving it registered.
    if (existsSync(worktreePath)) {
      deps.printError(
        `Warning: git status failed in worktree (exit ${statusExit}), attempting removal: ${worktreePath}`,
      );
      removeWorktreeWithVerification(effectiveRoot, worktreePath, deps, false);
    }
    return;
  }
  const status = rawStatus.trim();

  if (status === "") {
    // Capture branch name before removal (trim trailing newline from git output)
    const { stdout: rawBranch } = deps.exec(["git", "-C", worktreePath, "branch", "--show-current"]);
    const branch = rawBranch.trim();

    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      const hookEnv = buildHookEnv({ branch: worktree, path: worktreePath, cwd: effectiveRoot });
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (hookExit === 0 && !existsSync(worktreePath)) {
        deps.printInfo(`Removed worktree via hook: ${worktreePath}`);
        deleteIfSafeToDelete(branch, effectiveRoot, deps);
      } else if (hookExit === 0) {
        deps.printError(`Worktree teardown hook returned success but directory still exists: ${worktreePath}`);
      } else {
        deps.printError(`Worktree teardown hook failed for: ${worktreePath}: ${hookStderr}`);
      }
    } else {
      if (removeWorktreeWithVerification(effectiveRoot, worktreePath, deps)) {
        deleteIfSafeToDelete(branch, effectiveRoot, deps);
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

/**
 * Attempt `git worktree remove`, verify the directory is actually gone,
 * and retry with --force if needed. Only prints success after verification.
 * Returns true if the directory was verified removed.
 */
function removeWorktreeWithVerification(
  repoRoot: string,
  worktreePath: string,
  deps: WorktreeShimDeps,
  allowForce = true,
): boolean {
  const bareBeforeCleanup = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode: removeExit, stderr: removeStderr } = deps.exec([
    "git",
    "-C",
    repoRoot,
    "worktree",
    "remove",
    worktreePath,
  ]);

  if (removeExit === 0 && !bareBeforeCleanup && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError(
      `[shim] core.bare flipped to true by: git worktree remove ${worktreePath} (repo=${repoRoot}) — see #1330`,
    );
  }
  if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError("Fixed core.bare=true after worktree removal");
  }

  // Verify: directory must actually be gone
  if (!existsSync(worktreePath)) {
    deps.printInfo(`Removed worktree: ${worktreePath}`);
    return true;
  }

  if (!allowForce) {
    deps.printError(
      `Warning: worktree still exists after non-force removal; skipping --force because cleanliness could not be verified: ${worktreePath}`,
    );
    return false;
  }

  // Directory persists despite exit 0, or initial remove failed — retry with --force
  const bareBeforeForce = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode: forceExit, stderr: forceStderr } = deps.exec([
    "git",
    "-C",
    repoRoot,
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  if (forceExit === 0 && !bareBeforeForce && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError(
      `[shim] core.bare flipped to true by: git worktree remove --force ${worktreePath} (repo=${repoRoot}) — see #1330`,
    );
  }
  if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError("Fixed core.bare=true after worktree removal");
  }

  if (!existsSync(worktreePath)) {
    deps.printInfo(`Removed worktree (--force): ${worktreePath}`);
    return true;
  }

  // Both attempts failed — report with diagnostics
  const rawStderr = forceStderr || removeStderr;
  const stderrSummary = rawStderr
    ? ` (${rawStderr
        .trim()
        .replace(/\s*\n\s*/g, "; ")
        .slice(0, 200)})`
    : "";
  deps.printError(`Failed to remove worktree: ${worktreePath}${stderrSummary}`);
  return false;
}

/** Delete a branch if git branch -d considers it safe (merged into HEAD or upstream). */
function deleteIfSafeToDelete(branch: string, repoRoot: string, deps: WorktreeShimDeps): boolean {
  if (!branch) return false;
  const bareBeforeDelete = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode } = deps.exec(["git", "-C", repoRoot, "branch", "-d", branch]);
  if (exitCode === 0) {
    if (!bareBeforeDelete && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError(`[shim] core.bare flipped to true by: git branch -d ${branch} (repo=${repoRoot}) — see #1330`);
    }
    // Verify the branch is actually gone
    const { exitCode: verifyExit } = deps.exec([
      "git",
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ]);
    if (verifyExit !== 0) {
      deps.printInfo(`Deleted branch: ${branch} (safe)`);
      return true;
    }
    deps.printError(`Warning: git branch -d returned success but branch still exists: ${branch}`);
    return false;
  }
  return false;
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
export async function pruneWorktrees(opts: WorktreePruneOptions): Promise<WorktreePruneResult> {
  const { repoRoot, deps, dryRun = false, refreshActive } = opts;
  let activeWorktrees = opts.activeWorktrees;
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
  const removable: string[] = [];
  const skippedUnmerged: string[] = [];
  const deletedBranches = new Set<string>();
  // Resolve symlinks on cwd — macOS does not resolve them in process.cwd(),
  // so a shell that cd'd through a symlink into a candidate worktree would
  // bypass the "don't remove my cwd" guard below.
  const cwd = (() => {
    try {
      const raw = process.cwd();
      try {
        return realpathSync(raw);
      } catch {
        return raw;
      }
    } catch {
      return "";
    }
  })();

  for (const wt of worktrees) {
    const wtName = wt.path.slice(`${worktreeBase}/`.length);
    // Refresh active set between iterations to narrow the TOCTOU window
    // (orchestrator spawning a session into a candidate worktree).
    if (refreshActive && !dryRun) {
      try {
        activeWorktrees = await refreshActive();
      } catch {
        // Keep prior set on refresh failure.
      }
    }
    if (activeWorktrees.has(wtName)) continue;
    if (!skipMergeCheck && wt.branch && !mergedBranches.has(wt.branch)) {
      skippedUnmerged.push(wt.branch);
      continue;
    }

    // Check if clean (trim to handle trailing newline from some git versions)
    const { stdout: status, exitCode: statusExit } = deps.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    if (statusExit !== 0 || status.trim() !== "") continue;

    // Guard: refuse to remove a worktree that contains the current CWD.
    if (cwd && (cwd === wt.path || cwd.startsWith(`${wt.path}/`))) {
      deps.printError(`Skipping worktree containing current directory: ${wt.path}`);
      continue;
    }

    removable.push(wtName);
    if (dryRun) continue;

    // Remove worktree
    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      const hookEnv = buildHookEnv({ branch: wtName, path: wt.path, cwd: repoRoot });
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (hookExit === 0 && !existsSync(wt.path)) {
        deps.printInfo(`Removed worktree via hook: ${wt.path}`);
        pruned++;
        if (wt.branch && deleteIfSafeToDelete(wt.branch, repoRoot, deps)) {
          deletedBranches.add(wt.branch);
        }
      } else if (hookExit === 0) {
        deps.printError(`Worktree teardown hook returned success but directory still exists: ${wt.path}`);
      } else {
        deps.printError(`Worktree teardown hook failed for: ${wt.path}: ${hookStderr}`);
      }
    } else {
      if (removeWorktreeWithVerification(repoRoot, wt.path, deps)) {
        pruned++;
        if (wt.branch && deleteIfSafeToDelete(wt.branch, repoRoot, deps)) {
          deletedBranches.add(wt.branch);
        }
      }
    }
  }

  // Final guard: check core.bare one last time after all removals complete.
  // Individual per-removal fixes can be undone by subsequent removals in the
  // same batch. This ensures the repo is in a valid state when we return. #1206
  if (pruned > 0) {
    if (fixCoreBare(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError("Fixed core.bare=true after batch worktree prune");
    }
  }

  return { pruned, removable, skippedUnmerged, deletedBranches };
}

// ── Errors ──

/** Typed error for worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
