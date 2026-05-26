/**
 * Per-file closure-hash cache for test skipping.
 *
 * Given a test file and its transitive import closure (from the import
 * graph), computes a single hash over the content of the test file +
 * all its dependencies. When the hash matches the last green run, the
 * test file is skipped — its behaviour cannot have changed.
 *
 * The cache is stored at `build/.file-cache.json` and is keyed by
 * repo-relative test path. Eviction: LRU by timestamp, max 500 entries.
 *
 * See #2408.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { ImportGraph } from "../rules/_engine/import-graph";

const CACHE_FILE = "build/.file-cache.json";
const MAX_ENTRIES = 500;

export interface FileCacheEntry {
  /** Hash of (test file + transitive closure contents). */
  closureHash: string;
  /** Whether the test passed on the last run with this hash. */
  passed: boolean;
  /** ISO timestamp. */
  ts: string;
}

interface FileCacheFile {
  /** Bun version — invalidate entire cache on version change. */
  bunVersion: string;
  entries: Record<string, FileCacheEntry>;
}

/**
 * Compute a closure hash for a test file: hash of its own content
 * concatenated with all transitive dependency contents, sorted by path
 * for determinism.
 */
export function computeClosureHash(
  testFile: string,
  graph: ImportGraph,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  const closure = graph.closureOf(testFile);
  const allPaths = [testFile, ...Array.from(closure)].sort();

  const parts: string[] = [];
  for (const p of allPaths) {
    try {
      parts.push(readFile(p));
    } catch {
      // Missing file — include a sentinel so the hash changes if it appears later.
      parts.push(`\0MISSING:${p}`);
    }
  }

  return Bun.hash(parts.join("\0")).toString(16);
}

function cachePath(repoRoot: string): string {
  return join(repoRoot, CACHE_FILE);
}

export function readFileCache(repoRoot: string): FileCacheFile {
  const p = cachePath(repoRoot);
  if (!existsSync(p)) return { bunVersion: Bun.version, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as FileCacheFile;
    if (parsed.bunVersion !== Bun.version) return { bunVersion: Bun.version, entries: {} };
    if (!parsed.entries || typeof parsed.entries !== "object") return { bunVersion: Bun.version, entries: {} };
    return parsed;
  } catch {
    return { bunVersion: Bun.version, entries: {} };
  }
}

export function writeFileCache(repoRoot: string, cache: FileCacheFile): void {
  const p = cachePath(repoRoot);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(tmp, p);
}

/**
 * Look up whether a test file's closure hash matches a previous green run.
 * Returns true if the hash matches and the previous run passed.
 */
export function lookupFileVerdict(cache: FileCacheFile, relPath: string, closureHash: string): boolean {
  const entry = cache.entries[relPath];
  if (!entry) return false;
  return entry.closureHash === closureHash && entry.passed;
}

/**
 * Record the verdict for a set of test files after a run.
 */
export function storeFileVerdicts(
  cache: FileCacheFile,
  verdicts: { relPath: string; closureHash: string; passed: boolean }[],
): void {
  const now = new Date().toISOString();
  for (const { relPath, closureHash, passed } of verdicts) {
    cache.entries[relPath] = { closureHash, passed, ts: now };
  }
  evict(cache);
}

function evict(cache: FileCacheFile): void {
  const keys = Object.keys(cache.entries);
  if (keys.length <= MAX_ENTRIES) return;
  const sorted = keys.sort((a, b) => {
    const tA = cache.entries[a]?.ts ?? "";
    const tB = cache.entries[b]?.ts ?? "";
    return tA < tB ? -1 : tA > tB ? 1 : 0;
  });
  const excess = sorted.length - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) {
    const key = sorted[i];
    if (key) delete cache.entries[key];
  }
}

/**
 * Given a list of test file paths selected by `bun test --changed`,
 * filter out files whose closure hash matches a previous green run.
 *
 * Returns `{ toRun, skipped, hashes }` — `toRun` is what should be
 * passed to `bun test`, `skipped` is informational, and `hashes` is
 * the precomputed map for storing verdicts after the run.
 */
export function filterByClosureCache(opts: {
  testFiles: string[];
  repoRoot: string;
  graph: ImportGraph;
  readFile?: (path: string) => string;
}): {
  toRun: string[];
  skipped: string[];
  hashes: Map<string, string>;
} {
  const { testFiles, repoRoot, graph, readFile } = opts;
  const cache = readFileCache(repoRoot);
  const toRun: string[] = [];
  const skipped: string[] = [];
  const hashes = new Map<string, string>();

  for (const absPath of testFiles) {
    const relPath = relative(repoRoot, absPath);
    const hash = computeClosureHash(absPath, graph, readFile);
    hashes.set(absPath, hash);

    if (lookupFileVerdict(cache, relPath, hash)) {
      skipped.push(absPath);
    } else {
      toRun.push(absPath);
    }
  }

  return { toRun, skipped, hashes };
}
