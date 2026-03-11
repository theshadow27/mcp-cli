/**
 * Per-repo worktree lifecycle hook configuration.
 *
 * Read from `.mcx-worktree.json` in the repository root.
 * Allows projects to customize how worktrees are created and destroyed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Worktree lifecycle hook configuration */
export interface WorktreeHooksConfig {
  /** Command to run instead of `git worktree add`. Receives substitution variables. */
  setup?: string;
  /** Command to run instead of `git worktree remove`. Receives substitution variables. */
  teardown?: string;
  /** Base directory for worktrees (absolute or relative to repo root). Defaults to `.claude/worktrees`. */
  base?: string;
  /** Whether to prefix branch names (default true for non-hook, irrelevant when hooks manage branches). */
  branchPrefix?: boolean;
}

/** Config file shape */
interface WorktreeConfigFile {
  worktree?: WorktreeHooksConfig;
}

/** Config filename */
export const WORKTREE_CONFIG_FILENAME = ".mcx-worktree.json";

/**
 * Read worktree hook config from the repo root.
 * Returns null if no config file exists or if it has no `worktree` section.
 */
export function readWorktreeConfig(repoRoot: string): WorktreeHooksConfig | null {
  const configPath = join(repoRoot, WORKTREE_CONFIG_FILENAME);
  if (!existsSync(configPath)) return null;

  try {
    const text = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(text) as WorktreeConfigFile;
    return parsed.worktree ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the worktree base directory.
 * If config specifies a `base`, resolve it relative to repoRoot.
 * Otherwise, use the default `.claude/worktrees`.
 */
export function resolveWorktreeBase(repoRoot: string, config: WorktreeHooksConfig | null): string {
  if (config?.base) {
    return resolve(repoRoot, config.base);
  }
  return join(repoRoot, ".claude", "worktrees");
}

/**
 * Resolve the full worktree path for a given name.
 */
export function resolveWorktreePath(repoRoot: string, name: string, config: WorktreeHooksConfig | null): string {
  return join(resolveWorktreeBase(repoRoot, config), name);
}

/**
 * Substitute template variables in a hook command string.
 *
 * Supported variables:
 * - `{branch}` — the worktree/branch name
 * - `{path}` — the resolved worktree path
 * - `{cwd}` — the repo root
 */
export function substituteHookVars(template: string, vars: { branch: string; path: string; cwd: string }): string {
  return template
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{path\}/g, vars.path)
    .replace(/\{cwd\}/g, vars.cwd);
}

/**
 * Check whether worktree hooks are configured (i.e., a setup command exists).
 */
export function hasWorktreeHooks(
  config: WorktreeHooksConfig | null,
): config is WorktreeHooksConfig & { setup: string } {
  return config !== null && typeof config.setup === "string" && config.setup.length > 0;
}
