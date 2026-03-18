/**
 * Hash-based test timing cache.
 *
 * Stores per-file timing data keyed by content hash so that unchanged
 * test files are not re-profiled on every commit.  Budget violations
 * are reported as warnings — they never block commits.
 *
 * Cache file: test-timings.json (committed to the repo).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Glob } from "bun";

/** A single cached timing entry. */
export interface TimingEntry {
  /** xxhash64 hex digest of the file's content */
  hash: string;
  /** Wall-clock milliseconds for `bun test <file>` */
  timeMs: number;
}

/** Shape of the test-timings.json file. */
export type TimingCache = Record<string, TimingEntry>;

/** Compute an xxhash64 hex digest for a file's content. */
export function hashFileContent(content: string | Buffer): string {
  return Bun.hash(content).toString(16);
}

/** Read a file and return its xxhash64 hex hash. */
export async function hashFile(path: string): Promise<string> {
  const file = Bun.file(path);
  const buf = await file.arrayBuffer();
  return hashFileContent(new Uint8Array(buf));
}

/** Load timing cache from disk. Returns empty object if missing or corrupt. */
export function loadTimings(cachePath: string): TimingCache {
  if (!existsSync(cachePath)) return {};
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as TimingCache;
  } catch {
    return {};
  }
}

/** Save timing cache to disk as formatted JSON. */
export function saveTimings(cachePath: string, cache: TimingCache): void {
  // Sort keys for stable diffs
  const sorted: TimingCache = {};
  for (const key of Object.keys(cache).sort()) {
    sorted[key] = cache[key];
  }
  writeFileSync(cachePath, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Discover all test files in the project. */
export async function findTestFiles(cwd = "."): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Glob("**/*.spec.{ts,tsx}").scan({ cwd, onlyFiles: true })) {
    files.push(path);
  }
  return files.sort();
}

/**
 * Determine which test files need re-timing by comparing content hashes
 * against the cached values.
 *
 * Returns the list of files whose hash differs from the cache (or are new).
 */
export async function findChangedFiles(
  files: string[],
  cache: TimingCache,
): Promise<{ changed: string[]; hashes: Record<string, string> }> {
  const hashes: Record<string, string> = {};
  const changed: string[] = [];

  await Promise.all(
    files.map(async (file) => {
      const hash = await hashFile(file);
      hashes[file] = hash;
      const cached = cache[file];
      if (!cached || cached.hash !== hash) {
        changed.push(file);
      }
    }),
  );

  return { changed: changed.sort(), hashes };
}

/**
 * Prune entries from the cache whose files no longer exist on disk.
 * Returns the number of entries removed.
 */
export function pruneStaleEntries(cache: TimingCache, currentFiles: Set<string>): number {
  let removed = 0;
  for (const key of Object.keys(cache)) {
    if (!currentFiles.has(key)) {
      delete cache[key];
      removed++;
    }
  }
  return removed;
}
