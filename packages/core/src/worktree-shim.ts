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
import { ensureCoreBareUnset, isCoreBareSet } from "./git";
import {
  buildHookEnv,
  hasWorktreeHooks,
  readWorktreeConfig,
  resolveWorktreeBase,
  resolveWorktreePath,
} from "./worktree-config";

// ── Types ──

/** Bound the pre-fork `git fetch` so an unreachable remote can't hang spawn. */
const WORKTREE_FETCH_TIMEOUT_MS = 15_000;

/** Minimal dependency interface for worktree operations. */
export interface WorktreeShimDeps {
  exec: (
    cmd: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
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
  /**
   * Branches whose PR is MERGED or CLOSED on the forge, mapped to the PR's head
   * commit SHA (headRefOid). Squash-merges leave the branch tip as a
   * non-ancestor of the default branch, so `git branch --merged` never lists
   * them (#2662); a resolved PR is the authoritative "done" signal for those
   * worktrees. Branches removed via this signal are deleted with `-D` since
   * `git branch -d` rejects a non-ancestor tip.
   *
   * The head SHA is a data-loss backstop: a CLOSED PR whose author kept
   * committing locally (or never pushed a final commit) leaves a clean worktree
   * that is *ahead* of the forge. Reclaiming it would orphan those commits, so
   * the prune loop skips any tip ahead of `origin/<branch>`, falling back to the
   * head SHA when the remote ref has already been pruned.
   */
  resolvedByPr?: Map<string, string>;
}

/** Result of a prune operation. */
export interface WorktreePruneResult {
  /** Count of worktrees actually removed (0 in dry-run). */
  pruned: number;
  /** Names of worktrees that would be or were removed. */
  removable: string[];
  /** Names of worktrees that were actually removed (empty in dry-run). */
  prunedNames: string[];
  skippedUnmerged: string[];
  /**
   * Branches skipped because their clean worktree is ahead of the forge —
   * committed-but-unpushed work that reclaim-via-PR-state must not destroy.
   */
  skippedUnpushed: string[];
  /** Branches that were deleted (empty in dry-run). */
  deletedBranches: Set<string>;
}

// ── Create ──

/**
 * Resolve the start point for a new worktree branch.
 *
 * During an active merge train the local default branch lags origin, so forking
 * from local HEAD produces stale bases (#2679). Fetch origin's default branch
 * and fork from `origin/<branch>` instead. Falls back to HEAD silently when the
 * repo has no origin remote, and with a loud warning when the fetch fails
 * (offline, auth, unreachable).
 */
export function resolveWorktreeStartPoint(repoRoot: string, deps: WorktreeShimDeps): string {
  const remote = deps.exec(["git", "-C", repoRoot, "remote", "get-url", "origin"]);
  if (remote.exitCode !== 0) return "HEAD";

  const defaultBranch = getDefaultBranch(deps, repoRoot);
  const fetch = deps.exec(["git", "-C", repoRoot, "fetch", "origin", defaultBranch], {
    timeoutMs: WORKTREE_FETCH_TIMEOUT_MS,
  });
  if (fetch.exitCode !== 0) {
    deps.printError(
      `Warning: git fetch origin ${defaultBranch} failed — forking worktree from local HEAD, which may be stale (#2679): ${fetch.stderr.trim().slice(0, 200)}`,
    );
    return "HEAD";
  }

  const verify = deps.exec(["git", "-C", repoRoot, "rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}`]);
  if (verify.exitCode !== 0) {
    deps.printError(
      `Warning: origin/${defaultBranch} not found after fetch — forking worktree from local HEAD, which may be stale (#2679)`,
    );
    return "HEAD";
  }
  return `origin/${defaultBranch}`;
}

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
    const startPoint2 = resolveWorktreeStartPoint(repoRoot, deps);
    const bareBeforeAdd2 = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
    const { exitCode, stderr } = deps.exec([
      "git",
      "worktree",
      "add",
      "--no-track",
      worktreePath,
      "-b",
      name,
      startPoint2,
    ]);
    if (exitCode !== 0) {
      throw new WorktreeError(`Failed to create worktree: ${stderr}`);
    }
    if (!bareBeforeAdd2 && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError(
        `[shim] core.bare flipped to true by: git worktree add ${worktreePath} (repo=${repoRoot}) — see #1330`,
      );
    }
    const addResult2 = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
    if (addResult2 === "removed") {
      deps.printInfo("Removed core.bare key after worktree add");
    } else if (addResult2 === "fallback") {
      deps.printError("[shim] core.bare key could not be removed after worktree add — set to false as fallback");
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
  const startPoint4 = resolveWorktreeStartPoint(repoRoot, deps);
  const bareBeforeAdd4 = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode, stderr } = deps.exec([
    "git",
    "worktree",
    "add",
    "--no-track",
    worktreePath,
    "-b",
    gitBranch,
    startPoint4,
  ]);
  if (exitCode !== 0) {
    throw new WorktreeError(`Failed to create worktree: ${stderr}`);
  }
  if (!bareBeforeAdd4 && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError(
      `[shim] core.bare flipped to true by: git worktree add ${worktreePath} (repo=${repoRoot}) — see #1330`,
    );
  }
  const addResult4 = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
  if (addResult4 === "removed") {
    deps.printInfo("Removed core.bare key after worktree add");
  } else if (addResult4 === "fallback") {
    deps.printError("[shim] core.bare key could not be removed after worktree add — set to false as fallback");
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
      const bareBeforeHook = isCoreBareSet(effectiveRoot, (cmd) => deps.exec(cmd));
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (!bareBeforeHook && isCoreBareSet(effectiveRoot, (cmd) => deps.exec(cmd))) {
        deps.printError(
          `[shim] core.bare flipped to true by: teardown hook for ${worktreePath} (repo=${effectiveRoot}) — see #1330`,
        );
      }
      const hookBareResult = ensureCoreBareUnset(effectiveRoot, (cmd) => deps.exec(cmd));
      if (hookBareResult === "removed") {
        deps.printInfo("Removed core.bare key after teardown hook");
      } else if (hookBareResult === "fallback") {
        deps.printError("[shim] core.bare key could not be removed after teardown hook — set to false as fallback");
      }
      if (hookExit === 0 && !existsSync(worktreePath)) {
        deps.printInfo(`Removed worktree via hook: ${worktreePath}`);
        deletePrunedBranch(branch, effectiveRoot, deps);
      } else if (hookExit === 0) {
        deps.printError(`Worktree teardown hook returned success but directory still exists: ${worktreePath}`);
      } else {
        deps.printError(`Worktree teardown hook failed for: ${worktreePath}: ${hookStderr}`);
      }
    } else {
      if (removeWorktreeWithVerification(effectiveRoot, worktreePath, deps)) {
        deletePrunedBranch(branch, effectiveRoot, deps);
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
 * Whether a `git worktree remove` stderr indicates the path is no longer a
 * registered worktree (already removed). git's message is
 * `fatal: '<path>' is not a working tree`.
 */
function isNotAWorktreeError(stderr: string): boolean {
  return /not a working tree/i.test(stderr);
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

  // Idempotency: git reports "is not a working tree" when this path is no longer
  // a registered worktree — an earlier or concurrent teardown (e.g. a sibling
  // `bye` on a session sharing the worktree) already removed it. Treat as a
  // no-op success rather than surfacing a spurious error (#2836).
  if (removeExit !== 0 && isNotAWorktreeError(removeStderr)) {
    deps.printInfo(`Worktree already removed: ${worktreePath}`);
    return true;
  }

  if (removeExit === 0 && !bareBeforeCleanup && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
    deps.printError(
      `[shim] core.bare flipped to true by: git worktree remove ${worktreePath} (repo=${repoRoot}) — see #1330`,
    );
  }
  const removeResult1 = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
  if (removeResult1 === "removed") {
    deps.printInfo("Removed core.bare key after worktree removal");
  } else if (removeResult1 === "fallback") {
    deps.printError("[shim] core.bare key could not be removed after worktree removal — set to false as fallback");
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
  const removeResult2 = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
  if (removeResult2 === "removed") {
    deps.printInfo("Removed core.bare key after worktree removal");
  } else if (removeResult2 === "fallback") {
    deps.printError("[shim] core.bare key could not be removed after worktree removal — set to false as fallback");
  }

  if (!existsSync(worktreePath)) {
    deps.printInfo(`Removed worktree (--force): ${worktreePath}`);
    return true;
  }

  // Idempotency (concurrent teardown mid-force): if either attempt reported the
  // path is no longer a registered worktree, git already dropped it — no-op
  // success rather than a spurious "Failed to remove worktree" (#2836).
  if (isNotAWorktreeError(forceStderr) || isNotAWorktreeError(removeStderr)) {
    deps.printInfo(`Worktree already removed: ${worktreePath}`);
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

/**
 * Guard against orphaning committed-but-unpushed work when reclaiming a
 * worktree via the resolved-PR path (which routes around the ancestry check and
 * force-deletes the branch).
 *
 * Returns true — "do not reclaim" — when the local tip holds commits the forge
 * does not have:
 *  - If `origin/<branch>` exists, the tip is ahead iff `rev-list
 *    origin/<branch>..HEAD` is non-zero.
 *  - If the remote ref has been pruned, fall back to the PR's head SHA
 *    (`headRefOid`): equal ⇒ forge has exactly our tip (safe); anything else ⇒
 *    treat as ahead (a MERGED/CLOSED PR branch never advances on the forge, so
 *    any divergence is local-only work).
 *  - If neither signal is available, fail closed (protect).
 *
 * Remote-tracking refs live in the common git dir, so they are visible from the
 * worktree checkout; all queries run with `-C worktreePath` so `HEAD` is the
 * branch tip.
 */
function isAheadOfForge(
  worktreePath: string,
  branch: string,
  headRefOid: string | undefined,
  deps: WorktreeShimDeps,
): boolean {
  const head = deps.exec(["git", "-C", worktreePath, "rev-parse", "HEAD"]);
  if (head.exitCode !== 0) return true; // can't determine the local tip → protect
  const localTip = head.stdout.trim();

  const originRef = `refs/remotes/origin/${branch}`;
  const verify = deps.exec(["git", "-C", worktreePath, "rev-parse", "--verify", "--quiet", originRef]);
  if (verify.exitCode === 0) {
    const ahead = deps.exec(["git", "-C", worktreePath, "rev-list", "--count", `${originRef}..HEAD`]);
    if (ahead.exitCode !== 0) return true; // can't count → protect
    return Number(ahead.stdout.trim()) > 0;
  }

  // origin/<branch> pruned — the PR head SHA is the last thing the forge saw.
  if (headRefOid) return localTip !== headRefOid;

  return true; // no remote ref and no head SHA → protect
}

/**
 * Detect a squash-merge at the git layer via patch-equivalence (#2887).
 *
 * `git branch --merged` never lists a squash-merged branch because its tip is a
 * non-ancestor of the default branch, and a resolved PR is only visible while
 * `gh pr list` still returns it. This third signal is offline and
 * PR-independent: it synthesizes a single squash commit of the branch's
 * cumulative diff and asks whether that diff is already present in the default
 * branch.
 *
 *   mergeBase = git merge-base <defaultBranch> <branch>
 *   tree      = git rev-parse <branch>^{tree}
 *   dangling  = git commit-tree <tree> -p <mergeBase> -m _   # synthetic squash
 *   git cherry <defaultBranch> <dangling>   # '-' prefix ⇒ diff already in default
 *
 * `git cherry` compares by patch-id, so it only reports equivalence when the
 * branch's cumulative diff genuinely matches something already merged — a
 * branch that merely resembles main (unique diff) yields '+' and is NOT a
 * match. Any git failure returns false (fail-closed: never reclaim on
 * uncertainty). Branches matched here are non-ancestor tips, so callers must
 * delete with `-D` and must still honor the ahead-of-forge unpushed guard.
 */
export function isSquashMerged(
  repoRoot: string,
  branch: string,
  defaultBranch: string,
  deps: WorktreeShimDeps,
): boolean {
  const mergeBase = deps.exec(["git", "-C", repoRoot, "merge-base", defaultBranch, branch]);
  if (mergeBase.exitCode !== 0) return false;
  const base = mergeBase.stdout.trim();
  if (!base) return false;

  const tree = deps.exec(["git", "-C", repoRoot, "rev-parse", `${branch}^{tree}`]);
  if (tree.exitCode !== 0) return false;
  const treeSha = tree.stdout.trim();
  if (!treeSha) return false;

  const dangling = deps.exec(["git", "-C", repoRoot, "commit-tree", treeSha, "-p", base, "-m", "_"]);
  if (dangling.exitCode !== 0) return false;
  const danglingSha = dangling.stdout.trim();
  if (!danglingSha) return false;

  const cherry = deps.exec(["git", "-C", repoRoot, "cherry", defaultBranch, danglingSha]);
  if (cherry.exitCode !== 0) return false;
  // `git cherry` prints "- <sha>" when the change is already in defaultBranch
  // (patch-equivalent) and "+ <sha>" when it is unique. Empty output ⇒ nothing
  // to compare ⇒ not a match.
  return cherry.stdout.trim().startsWith("-");
}

/**
 * Delete a branch after its worktree is removed.
 *
 * Default (safe) uses `git branch -d`, which only deletes ancestry-merged
 * branches. Pass `force` when a resolved PR (MERGED/CLOSED) is the authority —
 * a squash-merged tip is a non-ancestor, so `-d` would refuse it (#2662).
 */
function deletePrunedBranch(branch: string, repoRoot: string, deps: WorktreeShimDeps, force = false): boolean {
  if (!branch) return false;
  const bareBeforeDelete = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
  const { exitCode } = deps.exec(["git", "-C", repoRoot, "branch", force ? "-D" : "-d", branch]);
  if (exitCode === 0) {
    if (!bareBeforeDelete && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
      deps.printError(
        `[shim] core.bare flipped to true by: git branch ${force ? "-D" : "-d"} ${branch} (repo=${repoRoot}) — see #1330`,
      );
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
    deps.printError(`Warning: git branch ${force ? "-D" : "-d"} returned success but branch still exists: ${branch}`);
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
  const { repoRoot, deps, dryRun = false, refreshActive, resolvedByPr } = opts;
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
  const prunedNames: string[] = [];
  const skippedUnmerged: string[] = [];
  const skippedUnpushed: string[] = [];
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
    // A branch is "done" when git ancestry says merged OR its PR is resolved
    // (MERGED/CLOSED) OR its cumulative diff is patch-equivalent to something
    // already in the default branch. The PR signal catches squash-merges whose
    // tip is a non-ancestor (#2662); the patch-equivalence signal catches the
    // same class offline when the PR has aged out of `gh pr list` or was never
    // opened (#2887). Only compute the (more expensive) git-level squash check
    // when the two cheaper signals miss.
    const ancestryMerged = wt.branch ? mergedBranches.has(wt.branch) : false;
    const prResolved = wt.branch ? (resolvedByPr?.has(wt.branch) ?? false) : false;
    const squashMerged =
      wt.branch && !ancestryMerged && !prResolved ? isSquashMerged(repoRoot, wt.branch, defaultBranch, deps) : false;
    if (!skipMergeCheck && wt.branch && !ancestryMerged && !prResolved && !squashMerged) {
      skippedUnmerged.push(wt.branch);
      continue;
    }

    // Both the PR-resolved and the squash-detected signals reclaim non-ancestor
    // tips, so both delete with `-D` and both must clear the ahead-of-forge
    // guard below.
    const nonAncestorReclaim = (prResolved || squashMerged) && !ancestryMerged;

    // Check if clean (trim to handle trailing newline from some git versions)
    const { stdout: status, exitCode: statusExit } = deps.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    if (statusExit !== 0 || status.trim() !== "") continue;

    // Data-loss guard: ancestry-merged tips are fully contained in the default
    // branch, but a non-ancestor tip reclaimed via PR-state (squash/closed) or
    // via git-level patch-equivalence can hold committed-but-unpushed work even
    // when the tree is clean. Reclaiming would `-D` the branch and orphan those
    // commits. Skip when the tip is ahead of the forge. A squash-detected branch
    // has no PR head SHA backstop, so isAheadOfForge falls back to the
    // origin/<branch> ref (protecting when it is absent) — see #2887.
    if (wt.branch && nonAncestorReclaim) {
      if (isAheadOfForge(wt.path, wt.branch, resolvedByPr?.get(wt.branch), deps)) {
        deps.printError(`Warning: worktree branch is ahead of the forge, not removing (unpushed commits): ${wt.path}`);
        skippedUnpushed.push(wt.branch);
        continue;
      }
    }

    // Guard: refuse to remove a worktree that contains the current CWD.
    if (cwd && (cwd === wt.path || cwd.startsWith(`${wt.path}/`))) {
      deps.printInfo(`Skipping worktree containing current directory: ${wt.path}`);
      continue;
    }

    removable.push(wtName);
    if (dryRun) continue;

    // Remove worktree
    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      const hookEnv = buildHookEnv({ branch: wtName, path: wt.path, cwd: repoRoot });
      const bareBeforePruneHook = isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd));
      const { exitCode: hookExit, stderr: hookStderr } = deps.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (!bareBeforePruneHook && isCoreBareSet(repoRoot, (cmd) => deps.exec(cmd))) {
        deps.printError(
          `[shim] core.bare flipped to true by: teardown hook for ${wt.path} (repo=${repoRoot}) — see #1330`,
        );
      }
      const pruneHookBareResult = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
      if (pruneHookBareResult === "removed") {
        deps.printInfo("Removed core.bare key after teardown hook");
      } else if (pruneHookBareResult === "fallback") {
        deps.printError("[shim] core.bare key could not be removed after teardown hook — set to false as fallback");
      }
      if (hookExit === 0 && !existsSync(wt.path)) {
        deps.printInfo(`Removed worktree via hook: ${wt.path}`);
        pruned++;
        prunedNames.push(wtName);
        if (wt.branch && deletePrunedBranch(wt.branch, repoRoot, deps, nonAncestorReclaim)) {
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
        prunedNames.push(wtName);
        if (wt.branch && deletePrunedBranch(wt.branch, repoRoot, deps, nonAncestorReclaim)) {
          deletedBranches.add(wt.branch);
        }
      }
    }
  }

  // Final guard: check core.bare one last time after all removals complete.
  // Individual per-removal fixes can be undone by subsequent removals in the
  // same batch. This ensures the repo is in a valid state when we return. #1206
  if (pruned > 0) {
    const batchResult = ensureCoreBareUnset(repoRoot, (cmd) => deps.exec(cmd));
    if (batchResult === "removed") {
      deps.printInfo("Removed core.bare key after batch worktree prune");
    } else if (batchResult === "fallback") {
      deps.printError(
        "[shim] core.bare key could not be removed after batch worktree prune — set to false as fallback",
      );
    }
  }

  return { pruned, removable, prunedNames, skippedUnmerged, skippedUnpushed, deletedBranches };
}

// ── Errors ──

/** Typed error for worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
