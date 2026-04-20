/**
 * Per-repo worktree lifecycle hook configuration.
 *
 * Primary source: the `worktree:` key of the project manifest (`.mcx.{yaml,yml,json}`).
 * Legacy source: `.mcx-worktree.json`. Contents are migrated into the manifest
 * on first read (see #1288); the legacy file is never deleted automatically,
 * and a nag is emitted on every subsequent run until the user removes it.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { MANIFEST_FILENAMES, findManifest, parseManifestText } from "./manifest";

/** Worktree lifecycle hook configuration */
export interface WorktreeHooksConfig {
  /** Command to run instead of `git worktree add`. Receives substitution variables. */
  setup?: string;
  /** Command to run instead of `git worktree remove`. Receives substitution variables. */
  teardown?: string;
  /** Base directory for worktrees (absolute or relative to repo root). Defaults to `.claude/worktrees`. */
  base?: string;
  /**
   * Whether to prepend a prefix to worktree branch names (`claude/` for headless, `headed/` for headed).
   * Set to `false` to use branch names exactly as provided.
   * Defaults to `true` (prefixes applied).
   */
  branchPrefix?: boolean;
}

/** Legacy config file shape */
interface WorktreeConfigFile {
  worktree?: WorktreeHooksConfig;
}

/** Legacy config filename — migrated into the manifest; retained for back-compat reads. */
export const WORKTREE_CONFIG_FILENAME = ".mcx-worktree.json";

/** Process-scoped dedup for the migration nag so we don't spam per call site. */
const naggedPaths = new Set<string>();

/** Manually serialize a worktree config as a YAML block (flat primitives only). */
function serializeWorktreeBlock(config: WorktreeHooksConfig): string {
  const lines: string[] = ["worktree:"];
  if (config.setup !== undefined) lines.push(`  setup: ${JSON.stringify(config.setup)}`);
  if (config.teardown !== undefined) lines.push(`  teardown: ${JSON.stringify(config.teardown)}`);
  if (config.base !== undefined) lines.push(`  base: ${JSON.stringify(config.base)}`);
  if (config.branchPrefix !== undefined) lines.push(`  branchPrefix: ${config.branchPrefix}`);
  return lines.join("\n");
}

/** Read the legacy `.mcx-worktree.json` file. */
function readLegacyFile(repoRoot: string): WorktreeHooksConfig | null {
  const configPath = join(repoRoot, WORKTREE_CONFIG_FILENAME);
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(text) as WorktreeConfigFile;
    return parsed.worktree ?? null;
  } catch (err) {
    console.error(`Warning: failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Atomically write `content` to `filePath` via a sibling temp file.
 * Prevents truncated-file corruption on SIGKILL / disk-full mid-write.
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/** Read the manifest's `worktree:` key without full validation. */
function readManifestWorktree(manifestPath: string): {
  worktree: WorktreeHooksConfig | null;
  raw: Record<string, unknown> | null;
  parseError: boolean;
} {
  try {
    const text = readFileSync(manifestPath, "utf-8");
    const parsed = parseManifestText(text, manifestPath);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { worktree: null, raw: null, parseError: false };
    }
    const raw = parsed as Record<string, unknown>;
    const w = raw.worktree;
    if (w && typeof w === "object" && !Array.isArray(w)) {
      return { worktree: w as WorktreeHooksConfig, raw, parseError: false };
    }
    return { worktree: null, raw, parseError: false };
  } catch {
    return { worktree: null, raw: null, parseError: true };
  }
}

/** Append a `worktree:` block to an existing yaml manifest. */
function appendWorktreeToYaml(manifestPath: string, config: WorktreeHooksConfig): void {
  const existing = readFileSync(manifestPath, "utf-8");
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = serializeWorktreeBlock(config);
  atomicWrite(manifestPath, `${existing}${sep}${block}\n`);
}

/** Merge a worktree section into an existing JSON manifest. */
function mergeWorktreeIntoJson(manifestPath: string, raw: Record<string, unknown>, config: WorktreeHooksConfig): void {
  raw.worktree = config;
  atomicWrite(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Create a new `.mcx.yaml` in repoRoot holding just the worktree section. */
function createYamlWithWorktree(repoRoot: string, config: WorktreeHooksConfig): string {
  const newPath = join(repoRoot, MANIFEST_FILENAMES[0]);
  atomicWrite(newPath, `${serializeWorktreeBlock(config)}\n`);
  return newPath;
}

/** Emit the post-migration nag once per process per legacy path. */
function emitNag(legacyPath: string, manifestPath: string): void {
  if (naggedPaths.has(legacyPath)) return;
  naggedPaths.add(legacyPath);
  console.error(
    `${legacyPath} is ignored — its contents were migrated to ${basename(manifestPath)} under \`worktree:\`. Delete ${legacyPath} to silence this warning.`,
  );
}

/** @internal test helper — reset the process-scoped nag dedup set. */
export function __resetNagStateForTests(): void {
  naggedPaths.clear();
}

/**
 * Read worktree hook config for `repoRoot`.
 *
 * Resolution order:
 *   1. Manifest (`.mcx.{yaml,yml,json}`) `worktree:` key — if set, this wins.
 *   2. Legacy `.mcx-worktree.json` — if found without a manifest counterpart,
 *      its contents are migrated into the manifest on this call. The legacy
 *      file is left in place; subsequent reads will emit a nag until it's
 *      manually deleted.
 *
 * Returns null if no worktree config exists in either location.
 */
export function readWorktreeConfig(repoRoot: string): WorktreeHooksConfig | null {
  const legacyPath = join(repoRoot, WORKTREE_CONFIG_FILENAME);
  const legacyExists = existsSync(legacyPath);
  const legacyConfig = legacyExists ? readLegacyFile(repoRoot) : null;

  const manifestPath = findManifest(repoRoot);
  const {
    worktree: manifestWorktree,
    raw: manifestRaw,
    parseError,
  } = manifestPath ? readManifestWorktree(manifestPath) : { worktree: null, raw: null, parseError: false };

  if (manifestWorktree) {
    if (legacyExists) emitNag(legacyPath, manifestPath as string);
    return manifestWorktree;
  }

  if (legacyConfig) {
    if (manifestPath && parseError) {
      // Manifest exists but couldn't be parsed — don't risk overwriting or shadowing it.
      // Surface the problem and return legacy config without migrating.
      console.error(
        `Warning: ${manifestPath} could not be parsed; skipping worktree migration. Fix the manifest first.`,
      );
      return legacyConfig;
    }
    if (manifestPath && manifestRaw) {
      if (manifestPath.toLowerCase().endsWith(".json")) {
        mergeWorktreeIntoJson(manifestPath, manifestRaw, legacyConfig);
      } else {
        appendWorktreeToYaml(manifestPath, legacyConfig);
      }
    } else {
      createYamlWithWorktree(repoRoot, legacyConfig);
    }
    return legacyConfig;
  }

  return null;
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
 * Build environment variables for hook execution.
 *
 * Passes context as env vars instead of string interpolation to prevent shell injection.
 * Hook commands use `$MCX_BRANCH`, `$MCX_PATH`, `$MCX_CWD` instead of template syntax.
 */
export function buildHookEnv(vars: { branch: string; path: string; cwd: string }): Record<string, string> {
  return {
    MCX_BRANCH: vars.branch,
    MCX_PATH: vars.path,
    MCX_CWD: vars.cwd,
  };
}

/**
 * Check whether worktree hooks are configured (i.e., a setup command exists).
 */
export function hasWorktreeHooks(
  config: WorktreeHooksConfig | null,
): config is WorktreeHooksConfig & { setup: string } {
  return config !== null && typeof config.setup === "string" && config.setup.length > 0;
}
