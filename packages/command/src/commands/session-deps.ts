/**
 * Shared default-dependency wrappers for session-based commands (claude, agent).
 *
 * Houses the git-root resolver, diff-stats, and PR-status helpers so that
 * `claude.ts`, `agent.ts`, and `session-display.ts` share one implementation.
 */

import { dirname, resolve } from "node:path";
import type { LookupResult } from "@mcp-cli/core";
import {
  GIT_REV_PARSE_TIMEOUT_MS,
  isLookupFailure,
  lookupFailure,
  resolveRealpath,
  runOrLookupFailure,
  spawnCaptureSync,
} from "@mcp-cli/core";

// ── Types ──

export interface PrStatus {
  number: number;
  state: string;
}

// ── Git root ──

/**
 * Resolve the git repo root for the current working directory.
 * Uses --git-common-dir to resolve to the main repo root, not a worktree.
 * Resolves symlinks via `resolveRealpath` so callers always get a canonical path.
 * Returns null if not inside a git repo.
 */
export function getGitRoot(): LookupResult<string | null> {
  const result = spawnCaptureSync("git", ["rev-parse", "--git-common-dir"], { timeoutMs: GIT_REV_PARSE_TIMEOUT_MS });
  if (!result.ok)
    return lookupFailure(`git rev-parse --git-common-dir failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  const commonDir = result.stdout.trim();
  if (!commonDir) return null;
  const resolved = resolve(commonDir);
  const root = resolved.endsWith(".git") ? dirname(resolved) : resolved;
  return resolveRealpath(root);
}

// ── Diff stats ──

/**
 * Parse `git diff --shortstat` output into a compact diff summary.
 * Returns e.g. `+142/-38 (4f)` or null if no changes / parse failure.
 */
export function parseDiffShortstat(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const filesMatch = trimmed.match(/(\d+)\s+file/);
  const insertMatch = trimmed.match(/(\d+)\s+insertion/);
  const deleteMatch = trimmed.match(/(\d+)\s+deletion/);

  const files = filesMatch ? Number(filesMatch[1]) : 0;
  const insertions = insertMatch ? Number(insertMatch[1]) : 0;
  const deletions = deleteMatch ? Number(deleteMatch[1]) : 0;

  if (files === 0 && insertions === 0 && deletions === 0) return null;

  return `+${insertions}/-${deletions} (${files}f)`;
}

export async function defaultGetDiffStats(worktreePath: string): Promise<LookupResult<string | null>> {
  const stdout = await runOrLookupFailure("git", ["diff", "--shortstat"], { cwd: worktreePath });
  if (isLookupFailure(stdout)) return stdout;
  return parseDiffShortstat(stdout);
}

// ── PR status ──

export async function defaultGetPrStatus(worktreePath: string): Promise<LookupResult<PrStatus | null>> {
  const branchOut = await runOrLookupFailure("git", ["branch", "--show-current"], { cwd: worktreePath });
  if (isLookupFailure(branchOut)) return branchOut;
  const branch = branchOut.trim();
  if (!branch) return null;

  const prOut = await runOrLookupFailure("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "number,state",
    "--limit",
    "1",
  ]);
  if (isLookupFailure(prOut)) return prOut;

  let prs: Array<{ number: number; state: string }>;
  try {
    prs = JSON.parse(prOut.trim()) as Array<{ number: number; state: string }>;
  } catch {
    return lookupFailure(`Failed to parse gh pr list output for ${worktreePath}: ${prOut.slice(0, 100)}`);
  }
  if (!Array.isArray(prs) || prs.length === 0) return null;
  const pr = prs[0];
  return { number: pr.number, state: pr.state.toLowerCase() };
}
