/**
 * Verdict cache for `--pre-push` test results.
 *
 * Memoizes the diff-aware test verdict keyed on a hash of the worktree
 * state: (merge-base SHA, HEAD SHA, working-tree diff content). A re-run
 * or re-push of the *same* state becomes a no-op — solves the
 * commit→push double-run and repeated-push cases without owning a
 * dependency graph. See #2396.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CACHE_FILE = "build/.verdict-cache.json";

interface VerdictEntry {
  key: string;
  passed: boolean;
  /** ISO timestamp of when this verdict was recorded. */
  ts: string;
}

interface VerdictCacheFile {
  entries: VerdictEntry[];
}

/**
 * Compute a cache key from the current worktree state.
 *
 * Components:
 *   1. merge-base SHA (the ref tests diff against)
 *   2. HEAD SHA (which commit we're on)
 *   3. hash of uncommitted changes (staged + unstaged)
 *
 * Any code change — commit, amend, stage, edit — flips at least one of
 * these, invalidating the cache.
 */
export function computeVerdictKey(resolveBase: () => string): string | null {
  const base = resolveBase();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return null;
  const headSha = head.stdout.trim();

  // `git diff HEAD` captures both staged and unstaged changes in one shot.
  const diff = spawnSync("git", ["diff", "HEAD"], { encoding: "utf8" });
  const diffContent = diff.status === 0 ? diff.stdout : "";
  const diffHash = Bun.hash(diffContent).toString(16);

  return `${base}:${headSha}:${diffHash}`;
}

function cachePath(repoRoot: string): string {
  return join(repoRoot, CACHE_FILE);
}

function readCache(repoRoot: string): VerdictCacheFile {
  const p = cachePath(repoRoot);
  if (!existsSync(p)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as VerdictCacheFile;
  } catch {
    return { entries: [] };
  }
}

function writeCache(repoRoot: string, cache: VerdictCacheFile): void {
  const p = cachePath(repoRoot);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, `${JSON.stringify(cache, null, 2)}\n`);
}

const MAX_ENTRIES = 16;

export function lookupVerdict(repoRoot: string, key: string): boolean | null {
  const cache = readCache(repoRoot);
  const entry = cache.entries.find((e) => e.key === key);
  if (!entry) return null;
  return entry.passed;
}

export function storeVerdict(repoRoot: string, key: string, passed: boolean): void {
  const cache = readCache(repoRoot);
  cache.entries = cache.entries.filter((e) => e.key !== key);
  cache.entries.unshift({ key, passed, ts: new Date().toISOString() });
  if (cache.entries.length > MAX_ENTRIES) cache.entries.length = MAX_ENTRIES;
  writeCache(repoRoot, cache);
}
