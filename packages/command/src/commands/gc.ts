/**
 * `mcx gc` — garbage-collect merged branches, stale worktrees, and remote refs.
 *
 * Safe: only deletes branches that `git branch -d` accepts (fully merged).
 * Worktrees are pruned using the existing safety checks (active session skip,
 * clean-only, merged-only). An age filter shields recently-used worktrees.
 */

import { statSync } from "node:fs";
import {
  WorktreeError,
  type WorktreeShimDeps,
  getDefaultBranch,
  listMcxWorktrees,
  pruneWorktrees,
} from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";
import { c, printError } from "../output";
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
  const opts: GcOptions = {
    dryRun: false,
    olderThanMs: DEFAULT_OLDER_THAN_MS,
    branchesOnly: false,
    worktreesOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--branches-only") opts.branchesOnly = true;
    else if (a === "--worktrees-only") opts.worktreesOnly = true;
    else if (a === "--older-than") {
      const v = args[++i];
      if (!v) throw new Error("--older-than requires a value (e.g. 1d, 3h)");
      opts.olderThanMs = parseDuration(v);
    } else if (a.startsWith("--older-than=")) {
      opts.olderThanMs = parseDuration(a.slice("--older-than=".length));
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
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
      const result = Bun.spawnSync(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      });
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
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
    printError,
    log: console.log,
    logError: console.error,
  };
}

/**
 * Core gc logic — pure enough to test with injected deps.
 */
export async function runGc(opts: GcOptions, deps: GcDeps): Promise<void> {
  const { cwd } = deps;
  const prefix = opts.dryRun ? `${c.dim}[dry-run]${c.reset} ` : "";

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
        return;
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
      return;
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

    // refreshActive re-queries sessions between removals (TOCTOU mitigation).
    // Only meaningful in live mode; in dry-run we don't execute.
    const refreshActive = opts.dryRun
      ? undefined
      : async (): Promise<Set<string>> => {
          try {
            return await getAllActiveSessionWorktrees(shimDeps, false);
          } catch {
            return activeWorktrees;
          }
        };
    const result = await pruneWorktrees({
      repoRoot: cwd,
      activeWorktrees,
      deps,
      dryRun: opts.dryRun,
      refreshActive,
    });

    worktreeDeletedBranches = result.deletedBranches;

    if (opts.dryRun) {
      deps.log(`${prefix}worktrees: would remove ${result.removable.length}`);
      for (const name of result.removable) deps.log(`  ${c.red}-${c.reset} ${name}`);
      if (result.skippedUnmerged.length > 0) {
        deps.log(`${prefix}worktrees: ${result.skippedUnmerged.length} skipped (unmerged)`);
      }
      if (recentSkipped.length > 0) {
        deps.log(`${prefix}worktrees: ${recentSkipped.length} skipped (too recent)`);
      }
    } else {
      const unmerged = result.skippedUnmerged.length > 0 ? `, skipped ${result.skippedUnmerged.length} unmerged` : "";
      const tooRecent = recentSkipped.length > 0 ? `, skipped ${recentSkipped.length} too recent` : "";
      deps.logError(`worktrees: removed ${result.pruned}${unmerged}${tooRecent}`);
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

    if (opts.dryRun) {
      deps.log(`${prefix}branches: would delete ${candidates.length} merged`);
      for (const b of candidates) deps.log(`  ${c.red}-${c.reset} ${b}`);
    } else {
      let deleted = 0;
      const failed: string[] = [];
      for (const b of candidates) {
        const { exitCode, stderr } = deps.exec(["git", "-C", cwd, "branch", "-d", b]);
        if (exitCode === 0) {
          deleted++;
        } else {
          failed.push(`${b}: ${stderr.trim()}`);
        }
      }
      deps.logError(`branches: deleted ${deleted}${failed.length > 0 ? `, ${failed.length} failed` : ""}`);
      for (const f of failed) deps.logError(`  ${f}`);
    }
  }
}

function getMergedBranches(deps: WorktreeShimDeps, cwd: string, defaultBranch: string): string[] {
  const { stdout, exitCode } = deps.exec(["git", "-C", cwd, "branch", "--merged", defaultBranch]);
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .map((l) => l.replace(/^\*?\s+/, "").trim())
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
  await runGc(opts, defaultGcDeps());
}
