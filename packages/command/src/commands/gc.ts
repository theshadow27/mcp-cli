/**
 * `mcx gc` — garbage-collect merged branches, stale worktrees, and remote refs.
 *
 * Safe: only deletes branches that `git branch -d` accepts (fully merged).
 * Worktrees are pruned using the existing safety checks (active session skip,
 * clean-only, merged-only). An age filter shields recently-used worktrees.
 */

import { statSync } from "node:fs";
import {
  GC_PRUNED,
  WorktreeError,
  type WorktreeShimDeps,
  getDefaultBranch,
  hasWorktreeHooks,
  listMcxWorktrees,
  pruneWorktrees,
  readWorktreeConfig,
  spawnCaptureSync,
} from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";
import { c, printError, printInfo } from "../output";
import { getAllActiveSessionWorktrees } from "./worktree-commands";

export interface GcOptions {
  dryRun: boolean;
  olderThanMs: number;
  branchesOnly: boolean;
  worktreesOnly: boolean;
}

const DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 1 day

/** Parse durations like "1d", "3h", "30m", "45s", "2w". */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) throw new Error(`Invalid duration: "${s}" (expected e.g. 30m, 3h, 1d, 2w)`);
  const n = Number(m[1]);
  const mul = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]] ?? 0;
  return n * mul;
}

export function parseGcArgs(args: string[]): GcOptions {
  const { flags, errors, help } = parseFlags(args, {
    "dry-run": { type: "boolean", alias: "n" },
    "branches-only": { type: "boolean" },
    "worktrees-only": { type: "boolean" },
    "older-than": { type: "string" },
  });

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  const olderThanRaw = flags["older-than"] as string | undefined;
  // Pre-migration: explicit empty rejection. parseFlags accepts "", so guard explicitly.
  if (olderThanRaw === "") {
    throw new Error("--older-than requires a value (e.g. 1d, 3h)");
  }

  const opts: GcOptions = {
    dryRun: (flags["dry-run"] as boolean) ?? false,
    olderThanMs: olderThanRaw ? parseDuration(olderThanRaw) : DEFAULT_OLDER_THAN_MS,
    branchesOnly: (flags["branches-only"] as boolean) ?? false,
    worktreesOnly: (flags["worktrees-only"] as boolean) ?? false,
  };

  if (opts.branchesOnly && opts.worktreesOnly) {
    throw new Error("--branches-only and --worktrees-only are mutually exclusive");
  }
  return opts;
}

function printUsage(): void {
  console.log(`mcx gc — garbage-collect merged branches and stale worktrees

Usage: mcx gc [options]

Options:
  --dry-run, -n         Show what would be cleaned without making changes
  --older-than <dur>    Only clean worktrees older than duration (default: 1d)
                        Supported suffixes: s, m, h, d, w (e.g. 3h, 2d)
  --branches-only       Only prune merged branches
  --worktrees-only      Only clean stale worktrees
  -h, --help            Show this help

Examples:
  mcx gc
  mcx gc --dry-run
  mcx gc --older-than 3d
  mcx gc --branches-only`);
}

export interface GcDeps extends WorktreeShimDeps {
  cwd: string;
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Returns mtime (ms since epoch) for the given path, or null if it can't be stat'd. */
  getMtime: (path: string) => number | null;
  /**
   * Returns branch→PR-state signals from one batched `gh` call, or null if the
   * API is unavailable. `merged` = branches with a MERGED PR (enables `-D`
   * force-delete of squash-merged branches). `resolved` maps every MERGED-or-
   * CLOSED branch to its PR head SHA (headRefOid) — the "done" signal that lets
   * worktree GC reclaim squash-merged and abandoned-PR worktrees `git branch
   * --merged` can't see (#2662), while the head SHA guards against orphaning
   * unpushed commits when `origin/<branch>` has been pruned.
   */
  queryPrBranches: (cwd: string) => { merged: Set<string>; resolved: Map<string, string> } | null;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

/** Route a session_list tool to the matching provider server. */
const SESSION_TOOL_SERVER: Record<string, string> = {
  claude_session_list: "_claude",
  codex_session_list: "_codex",
  acp_session_list: "_acp",
  opencode_session_list: "_opencode",
};

export function defaultGcDeps(): GcDeps {
  return {
    cwd: process.cwd(),
    callTool: (tool, args) => {
      const server = SESSION_TOOL_SERVER[tool] ?? "_claude";
      return ipcCall("callTool", { server, tool, arguments: args });
    },
    exec: (cmd, opts) => {
      // spawnCaptureSync replaces the env when provided; merge with process.env
      // here so callers that pass a few extra vars still inherit PATH etc.
      const env = opts?.env ? { ...process.env, ...opts.env } : undefined;
      const result = spawnCaptureSync(cmd[0] ?? "", cmd.slice(1), { env });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
      };
    },
    getMtime: (path) => {
      // node:fs statSync is Bun's native implementation — not a compat shim.
      // Bun.file().lastModified returns a max-int sentinel for missing paths
      // and Bun.file().exists() returns false for directories, so neither
      // works here (worktree paths are directories).
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    },
    queryPrBranches: (cwd) => {
      const result = spawnCaptureSync(
        "gh",
        ["pr", "list", "--state", "all", "--json", "headRefName,state,headRefOid", "--limit", "1000"],
        { cwd },
      );
      if (!result.ok) return null;
      try {
        const prs = JSON.parse(result.stdout) as Array<{ headRefName: string; state: string; headRefOid: string }>;
        const merged = new Set<string>();
        const resolved = new Map<string, string>();
        for (const pr of prs) {
          if (pr.state === "MERGED") {
            merged.add(pr.headRefName);
            resolved.set(pr.headRefName, pr.headRefOid);
          } else if (pr.state === "CLOSED") {
            resolved.set(pr.headRefName, pr.headRefOid);
          }
        }
        return { merged, resolved };
      } catch {
        return null;
      }
    },
    printError,
    printInfo,
    log: console.log,
    logError: console.error,
  };
}

export interface GcResult {
  prunedWorktrees: string[];
  deletedBranches: string[];
}

/**
 * Core gc logic — pure enough to test with injected deps.
 */
export async function runGc(opts: GcOptions, deps: GcDeps): Promise<GcResult> {
  const { cwd } = deps;
  const prefix = opts.dryRun ? `${c.dim}[dry-run]${c.reset} ` : "";
  const gcResult: GcResult = { prunedWorktrees: [], deletedBranches: [] };

  // Fetch PR-state signals at most once per run — both the worktree and branch
  // phases consume it. `undefined` = not yet fetched; `null` = fetched but the
  // API was unavailable.
  let prBranchesCache: { merged: Set<string>; resolved: Map<string, string> } | null | undefined;
  const getPrBranches = (): { merged: Set<string>; resolved: Map<string, string> } | null => {
    if (prBranchesCache === undefined) prBranchesCache = deps.queryPrBranches(cwd);
    return prBranchesCache;
  };

  // Branches deleted during the worktree phase — skipped by the branch phase
  // to avoid "not found" false failures on the second `git branch -d`.
  let worktreeDeletedBranches = new Set<string>();

  // Branches currently checked out by any worktree — must not be deleted.
  // Captured from listMcxWorktrees during the worktree phase (if run) to
  // avoid a second independent `git worktree list` syscall and a TOCTOU
  // window between the two snapshots.
  let checkedOutFromList: Set<string> | null = null;

  // --- Worktrees ---
  if (!opts.branchesOnly) {
    // Fail-closed for live mode (don't destroy worktrees if daemon is
    // unreachable). For --dry-run, fail-open and warn — inspection must
    // degrade gracefully; nothing destructive happens.
    let activeWorktrees: Set<string>;
    const shimDeps = {
      ...deps,
      exit: ((code: number) => process.exit(code)) as (code: number) => never,
    };
    try {
      activeWorktrees = await getAllActiveSessionWorktrees(shimDeps, true);
    } catch (e) {
      if (!opts.dryRun) {
        deps.logError(`gc: ${e instanceof Error ? e.message : String(e)}`);
        return gcResult;
      }
      // dry-run: degrade gracefully — warn and continue with empty set.
      deps.logError("gc: active-session filter skipped — daemon unreachable (dry-run)");
      activeWorktrees = new Set();
    }

    // Add too-recent worktrees to the "active" set so pruneWorktrees skips them.
    const ageCutoff = Date.now() - opts.olderThanMs;
    let listed: ReturnType<typeof listMcxWorktrees>;
    try {
      listed = listMcxWorktrees(cwd, deps);
    } catch (e) {
      deps.logError(`gc: ${e instanceof WorktreeError ? e.message : String(e)}`);
      return gcResult;
    }

    const recentSkipped: string[] = [];
    for (const wt of listed.worktrees) {
      const name = wt.path.slice(`${listed.worktreeBase}/`.length);
      const mtime = deps.getMtime(wt.path);
      if (mtime !== null && mtime > ageCutoff) {
        activeWorktrees.add(name);
        recentSkipped.push(name);
      }
    }

    // Thread checked-out branches to the branch phase — avoid a second
    // independent `git worktree list --porcelain` call (and its TOCTOU).
    checkedOutFromList = new Set<string>();
    for (const wt of listed.allWorktrees) {
      if (wt.branch) checkedOutFromList.add(wt.branch);
    }

    // PR-state signal: lets prune reclaim squash-merged and closed-PR worktrees
    // that `git branch --merged` can't see (#2662). Only query when there are
    // mcx worktrees to consider; warn (but continue with ancestry-only) if the
    // forge is unreachable.
    let resolvedByPr: Map<string, string> | undefined;
    if (listed.worktrees.length > 0) {
      const pr = getPrBranches();
      if (pr) {
        resolvedByPr = pr.resolved;
      } else {
        deps.logError("gc: GitHub API unavailable — squash-merged/closed worktrees may not be reclaimed");
      }
    }

    // refreshActive re-queries sessions between removals (TOCTOU mitigation).
    // Only meaningful in live mode; in dry-run we don't execute.
    //
    // IMPORTANT: fail-closed here. `failClosed=false` silently returns an
    // empty Set when the daemon is unreachable — which would then be
    // treated as "no sessions are active" and prune every remaining
    // candidate mid-loop. `failClosed=true` throws on daemon loss, and we
    // preserve the last-known-good active set so in-flight sessions are
    // still protected. See PR #1278 round-2 review.
    const refreshActive = opts.dryRun
      ? undefined
      : async (): Promise<Set<string>> => {
          try {
            return await getAllActiveSessionWorktrees(shimDeps, true);
          } catch (e) {
            deps.logError(
              `gc: daemon unreachable during prune — preserving last-known active set (${activeWorktrees.size} entries): ${e instanceof Error ? e.message : String(e)}`,
            );
            return activeWorktrees;
          }
        };
    const result = await pruneWorktrees({
      repoRoot: cwd,
      activeWorktrees,
      deps,
      dryRun: opts.dryRun,
      refreshActive,
      resolvedByPr,
    });

    worktreeDeletedBranches = result.deletedBranches;

    if (opts.dryRun) {
      deps.log(`${prefix}worktrees: would remove ${result.removable.length}`);
      for (const name of result.removable) deps.log(`  ${c.red}-${c.reset} ${name}`);
      if (result.skippedUnmerged.length > 0) {
        deps.log(`${prefix}worktrees: ${result.skippedUnmerged.length} skipped (unmerged)`);
      }
      if (result.skippedUnpushed.length > 0) {
        deps.log(`${prefix}worktrees: ${result.skippedUnpushed.length} skipped (unpushed commits)`);
      }
      if (recentSkipped.length > 0) {
        deps.log(`${prefix}worktrees: ${recentSkipped.length} skipped (too recent)`);
      }
      // Teardown hooks run in live mode only; a failing hook keeps the
      // worktree but still shows in this list. Warn so users aren't
      // surprised by a delta between dry-run and live counts. See #1278.
      const wtConfig = readWorktreeConfig(cwd);
      if (result.removable.length > 0 && hasWorktreeHooks(wtConfig) && wtConfig?.teardown) {
        deps.log(`${prefix}note: teardown hook success is not simulated — live count may be lower`);
      }
    } else {
      const unmerged = result.skippedUnmerged.length > 0 ? `, skipped ${result.skippedUnmerged.length} unmerged` : "";
      const unpushed = result.skippedUnpushed.length > 0 ? `, skipped ${result.skippedUnpushed.length} unpushed` : "";
      const tooRecent = recentSkipped.length > 0 ? `, skipped ${recentSkipped.length} too recent` : "";
      deps.logError(`worktrees: removed ${result.pruned}${unmerged}${unpushed}${tooRecent}`);
      if (result.pruned > 0) {
        gcResult.prunedWorktrees = result.prunedNames;
        for (const b of result.deletedBranches) {
          if (!gcResult.deletedBranches.includes(b)) gcResult.deletedBranches.push(b);
        }
      }
    }
  }

  // --- Branches ---
  if (!opts.worktreesOnly) {
    // git fetch --prune — drop stale remote-tracking refs before checking merged branches
    if (!opts.dryRun) {
      const fetched = deps.exec(["git", "-C", cwd, "fetch", "--prune"]);
      if (fetched.exitCode !== 0) {
        deps.logError(`gc: git fetch --prune failed: ${fetched.stderr.trim()}`);
      }
    } else {
      deps.log(`${prefix}would run: git fetch --prune`);
    }

    const defaultBranch = getDefaultBranch(deps, cwd);
    // Reuse checked-out set from the worktree phase if available; else fall
    // back to an independent query (branches-only mode).
    const checkedOut = checkedOutFromList ?? getCheckedOutBranches(deps, cwd);
    const mergedBranches = getMergedBranches(deps, cwd, defaultBranch);
    const current = getCurrentBranch(deps, cwd);

    const candidates = mergedBranches.filter(
      (b) => b !== defaultBranch && b !== current && !checkedOut.has(b) && !worktreeDeletedBranches.has(b),
    );

    // Query GitHub for branches with merged PRs — enables force-delete for
    // squash/rebase-merged branches where `git branch -d` fails. Reuses the
    // per-run PR-state cache shared with the worktree phase.
    const mergedPrBranches = candidates.length > 0 ? (getPrBranches()?.merged ?? null) : null;
    if (candidates.length > 0 && !mergedPrBranches) {
      deps.logError("gc: GitHub API unavailable — squash-merged branches may not be cleaned");
    }

    if (opts.dryRun) {
      deps.log(`${prefix}branches: would delete ${candidates.length} merged`);
      for (const b of candidates) deps.log(`  ${c.red}-${c.reset} ${b}`);
    } else {
      let deleted = 0;
      const failed: string[] = [];
      for (const b of candidates) {
        const prConfirmed = mergedPrBranches?.has(b) ?? false;
        const flag = prConfirmed ? "-D" : "-d";
        const { exitCode, stderr } = deps.exec(["git", "-C", cwd, "branch", flag, b]);
        if (exitCode === 0) {
          deleted++;
          gcResult.deletedBranches.push(b);
        } else {
          failed.push(`${b}: ${stderr.trim()}`);
        }
      }
      deps.logError(`branches: deleted ${deleted}${failed.length > 0 ? `, ${failed.length} failed` : ""}`);
      for (const f of failed) deps.logError(`  ${f}`);
    }
  }

  return gcResult;
}

function getMergedBranches(deps: WorktreeShimDeps, cwd: string, defaultBranch: string): string[] {
  const { stdout, exitCode } = deps.exec(["git", "-C", cwd, "branch", "--merged", defaultBranch]);
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .map((l) => l.replace(/^[*+]?\s+/, "").trim())
    .filter(Boolean);
}

function getCurrentBranch(deps: WorktreeShimDeps, cwd: string): string {
  const { stdout, exitCode } = deps.exec(["git", "-C", cwd, "branch", "--show-current"]);
  return exitCode === 0 ? stdout.trim() : "";
}

/** Branches currently checked out by any worktree — must not be deleted. */
function getCheckedOutBranches(deps: WorktreeShimDeps, cwd: string): Set<string> {
  const { stdout, exitCode } = deps.exec(["git", "-C", cwd, "worktree", "list", "--porcelain"]);
  const set = new Set<string>();
  if (exitCode !== 0) return set;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("branch refs/heads/")) set.add(line.slice("branch refs/heads/".length));
  }
  return set;
}

export async function cmdGc(args: string[], overrides: { dryRun?: boolean } = {}): Promise<void> {
  let opts: GcOptions;
  try {
    opts = parseGcArgs(args);
  } catch (e) {
    printError(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (overrides.dryRun) opts.dryRun = true;
  const result = await runGc(opts, defaultGcDeps());

  if (!opts.dryRun && (result.prunedWorktrees.length > 0 || result.deletedBranches.length > 0)) {
    try {
      await ipcCall("publishEvent", {
        src: "cli.gc",
        event: GC_PRUNED,
        category: "gc",
        extra: {
          worktrees: result.prunedWorktrees,
          branches: result.deletedBranches,
          reason: "manual",
        },
      });
    } catch {
      // Best-effort: daemon may be unavailable
    }
  }
}
