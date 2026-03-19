/**
 * File-based cache for defineAlias handlers.
 *
 * Each entry is stored as a JSON file: { value, expiresAt }
 * Entries are namespaced by prefix (defaults to alias name).
 * Cache dir: ~/.mcp-cli/cache/alias/<prefix>/<key>.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CacheOptions } from "./alias";
import { options } from "./constants";

/** Default TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** On-disk cache entry shape */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Base directory for alias caches */
function aliasCacheBase(): string {
  return join(options.CACHE_DIR, "alias");
}

/** Sanitize a cache key for safe use as a filename */
function sanitizeKey(key: string): string {
  // Replace any non-alphanumeric/hyphen/underscore/dot chars with underscore
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Create a cache function bound to a specific alias name.
 * Returns the cache() function that gets injected into AliasContext.
 */
export function createAliasCache(
  aliasName: string,
): <T>(key: string, producer: () => T | Promise<T>, opts?: CacheOptions) => Promise<T> {
  return async <T>(key: string, producer: () => T | Promise<T>, opts?: CacheOptions): Promise<T> => {
    const prefix = opts?.prefix ?? aliasName;
    const ttl = opts?.ttl ?? DEFAULT_TTL_MS;
    const dir = join(aliasCacheBase(), sanitizeKey(prefix));
    const filePath = join(dir, `${sanitizeKey(key)}.json`);

    // Try to read existing cache entry
    try {
      const raw = await Bun.file(filePath).text();
      const entry: CacheEntry<T> = JSON.parse(raw);
      if (entry.expiresAt > Date.now()) {
        return entry.value;
      }
    } catch {
      // Cache miss or corrupt — fall through to producer
    }

    // Call producer and write cache
    const value = await producer();
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttl };

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await Bun.write(filePath, JSON.stringify(entry));

    return value;
  };
}

/**
 * Prune expired cache entries from the alias cache directory.
 * Safe to call on daemon startup — tolerates missing directories.
 * Returns the number of entries removed.
 */
export function pruneExpiredCache(): number {
  const base = aliasCacheBase();
  if (!existsSync(base)) return 0;

  let pruned = 0;
  const now = Date.now();

  for (const prefixDir of readdirSync(base)) {
    const prefixPath = join(base, prefixDir);
    try {
      if (!statSync(prefixPath).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const file of readdirSync(prefixPath)) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(prefixPath, file);
      try {
        const content = JSON.parse(readFileSync(filePath, "utf-8")) as CacheEntry<unknown>;
        if (content.expiresAt <= now) {
          unlinkSync(filePath);
          pruned++;
        }
      } catch {
        // Corrupt entry — remove it
        try {
          unlinkSync(filePath);
          pruned++;
        } catch {
          // Already gone
        }
      }
    }

    // Remove empty prefix directories
    try {
      const remaining = readdirSync(prefixPath);
      if (remaining.length === 0) {
        rmSync(prefixPath, { recursive: true });
      }
    } catch {
      // ignore
    }
  }

  return pruned;
}
