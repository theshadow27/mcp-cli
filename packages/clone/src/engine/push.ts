/**
 * Push engine — write local changes back to the remote provider.
 *
 * Handles three cases:
 * 1. Modified files (in cache, content hash differs) → update remote page
 * 2. New files (on disk, not in cache) → create remote page
 * 3. Deleted files (in cache, not on disk) → delete remote page
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { RemoteProvider, ResolvedScope } from "../providers/provider";
import type { CachedEntry } from "./cache";
import { CloneCache } from "./cache";
import { stripFrontmatter } from "./frontmatter";

export interface PushOptions {
  /** Root directory of the cloned repo. */
  repoDir: string;
  /** Provider instance. */
  provider: RemoteProvider;
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Dry run — show what would be pushed without pushing. */
  dryRun?: boolean;
}

export interface PushFileResult {
  path: string;
  pageId: string;
  status: "pushed" | "created" | "deleted" | "conflict" | "error" | "skipped";
  message?: string;
  newVersion?: number;
}

export interface PushSyncResult {
  /** Per-file results. */
  files: PushFileResult[];
  /** Number of files successfully pushed/created/deleted. */
  pushed: number;
  /** Number of new pages created. */
  created: number;
  /** Number of pages deleted. */
  deleted: number;
  /** Number of conflicts. */
  conflicts: number;
  /** Number of errors. */
  errors: number;
}

function log(opts: PushOptions, msg: string): void {
  if (opts.onProgress) opts.onProgress(msg);
  else process.stderr.write(`${msg}\n`);
}

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

/** Recursively find all .md files under a directory, excluding .git and .clone. */
function findMarkdownFiles(dir: string, rootDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".clone" || entry.name === ".gitignore") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(full, rootDir));
    } else if (entry.name.endsWith(".md")) {
      results.push(relative(rootDir, full));
    }
  }
  return results;
}

/** Derive a page title from a file path. */
function titleFromPath(relPath: string): string {
  const file = basename(relPath, ".md");
  // _index.md → use parent directory name
  if (file === "_index") {
    return basename(dirname(relPath));
  }
  return file;
}

/** Find the parent page ID for a new file by looking up its parent directory in the cache. */
function findParentId(relPath: string, cache: CloneCache, provider: string, scopeKey: string): string | undefined {
  // Walk up directory levels looking for a cached _index.md or parent
  const parentDir = dirname(relPath);
  if (parentDir === ".") return undefined;

  // Check for _index.md in the parent directory (that's the parent page)
  const parentIndex = join(parentDir, "_index.md");
  const cached = cache.getByPath(parentIndex);
  if (cached) return cached.id;

  // Check if the parent directory itself maps to a page (leaf that became a parent)
  const parentAsFile = `${parentDir}.md`;
  const cachedFile = cache.getByPath(parentAsFile);
  if (cachedFile) return cachedFile.id;

  // Walk up further
  return findParentId(parentDir, cache, provider, scopeKey);
}

export async function push(opts: PushOptions): Promise<PushSyncResult> {
  const { repoDir, provider, dryRun = false } = opts;
  const cachePath = join(repoDir, ".clone", "cache.sqlite");

  if (!existsSync(cachePath)) {
    throw new Error(`No cache found at ${cachePath}. Is this a cloned repo? Use "mcx vfs clone" first.`);
  }

  const cache = new CloneCache(cachePath);
  const result: PushSyncResult = { files: [], pushed: 0, created: 0, deleted: 0, conflicts: 0, errors: 0 };

  try {
    const scope = cache.findFirstScope(provider.name);
    if (!scope) throw new Error("No scope found in cache.");

    log(opts, `Pushing to ${provider.name}/${scope.key}...`);

    const cachedEntries = cache.listScope(provider.name, scope.key);
    const cachedByPath = new Map(cachedEntries.map((e) => [e.localPath, e]));

    // ── Scan for all local .md files ─────────────────────────
    const localFiles = findMarkdownFiles(repoDir, repoDir);
    const localFileSet = new Set(localFiles);

    // ── Categorize changes ───────────────────────────────────
    const modified: Array<{ cached: CachedEntry; rawContent: string }> = [];
    const created: Array<{ relPath: string; rawContent: string; title: string }> = [];
    const deleted: CachedEntry[] = [];

    // Check cached entries for modifications and deletions
    for (const cached of cachedEntries) {
      if (!localFileSet.has(cached.localPath)) {
        deleted.push(cached);
        continue;
      }

      const absPath = join(repoDir, cached.localPath);
      const localContent = readFileSync(absPath, "utf-8");
      const { content: rawContent } = stripFrontmatter(localContent);
      const hash = contentHash(rawContent);

      if (hash !== cached.contentHash) {
        modified.push({ cached, rawContent });
      }
    }

    // Check local files for new ones (not in cache)
    for (const relPath of localFiles) {
      if (!cachedByPath.has(relPath)) {
        const absPath = join(repoDir, relPath);
        const localContent = readFileSync(absPath, "utf-8");
        const { content: rawContent } = stripFrontmatter(localContent);
        const title = titleFromPath(relPath);
        created.push({ relPath, rawContent, title });
      }
    }

    const totalChanges = modified.length + created.length + deleted.length;
    if (totalChanges === 0) {
      log(opts, "Nothing to push. All files match remote.");
      return result;
    }

    // ── Report what we found ─────────────────────────────────
    if (modified.length > 0) {
      log(opts, `Modified (${modified.length}):`);
      for (const { cached } of modified) log(opts, `  ~ ${cached.localPath}`);
    }
    if (created.length > 0) {
      log(opts, `New (${created.length}):`);
      for (const { relPath } of created) log(opts, `  + ${relPath}`);
    }
    if (deleted.length > 0) {
      log(opts, `Deleted (${deleted.length}):`);
      for (const cached of deleted) log(opts, `  - ${cached.localPath}`);
    }

    if (dryRun) {
      log(opts, "\n(dry run — no changes pushed)");
      for (const { cached } of modified) {
        result.files.push({ path: cached.localPath, pageId: cached.id, status: "skipped", message: "dry run" });
      }
      for (const { relPath } of created) {
        result.files.push({ path: relPath, pageId: "", status: "skipped", message: "dry run (new)" });
      }
      for (const cached of deleted) {
        result.files.push({
          path: cached.localPath,
          pageId: cached.id,
          status: "skipped",
          message: "dry run (delete)",
        });
      }
      return result;
    }

    // ── Push modifications ───────────────────────────────────
    if (provider.push) {
      for (const { cached, rawContent } of modified) {
        await pushModified(opts, provider, scope, cache, cached, rawContent, result);
      }
    }

    // ── Create new pages ─────────────────────────────────────
    if (provider.create) {
      for (const { relPath, rawContent, title } of created) {
        await pushCreated(opts, provider, scope, cache, relPath, rawContent, title, result);
      }
    } else if (created.length > 0) {
      log(opts, `  (provider doesn't support create — ${created.length} new file(s) skipped)`);
    }

    // ── Delete pages ─────────────────────────────────────────
    if (provider.delete) {
      for (const cached of deleted) {
        await pushDeleted(opts, provider, scope, cache, cached, result);
      }
    } else if (deleted.length > 0) {
      log(opts, `  (provider doesn't support delete — ${deleted.length} deleted file(s) skipped)`);
    }

    const parts: string[] = [];
    if (result.pushed > 0) parts.push(`${result.pushed} updated`);
    if (result.created > 0) parts.push(`${result.created} created`);
    if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
    if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
    if (result.errors > 0) parts.push(`${result.errors} errors`);
    log(opts, `\nPush complete. ${parts.join(", ")}.`);
  } finally {
    cache.close();
  }

  return result;
}

async function pushModified(
  opts: PushOptions,
  provider: RemoteProvider,
  scope: ResolvedScope,
  cache: CloneCache,
  cached: CachedEntry,
  rawContent: string,
  result: PushSyncResult,
): Promise<void> {
  log(opts, `  pushing ${cached.localPath}...`);
  try {
    const pushResult = await provider.push?.(scope, cached.id, rawContent, cached.version);
    if (!pushResult) throw new Error("Provider push returned no result");

    if (pushResult.ok) {
      const newVersion = pushResult.newVersion ?? cached.version + 1;
      cache.upsert(
        provider.name,
        scope,
        {
          id: cached.id,
          title: cached.title,
          parentId: cached.parentId ?? undefined,
          version: newVersion,
          lastModified: new Date().toISOString(),
          metadata: {},
        },
        cached.localPath,
        contentHash(rawContent),
      );

      result.files.push({ path: cached.localPath, pageId: cached.id, status: "pushed", newVersion });
      result.pushed++;
      log(opts, `    ✓ updated (v${cached.version} → v${newVersion})`);
    } else {
      const isConflict = pushResult.error?.includes("conflict") || pushResult.error?.includes("version");
      result.files.push({
        path: cached.localPath,
        pageId: cached.id,
        status: isConflict ? "conflict" : "error",
        message: pushResult.error,
      });
      if (isConflict) {
        result.conflicts++;
        log(opts, `    ✗ conflict: ${pushResult.error}`);
      } else {
        result.errors++;
        log(opts, `    ✗ error: ${pushResult.error}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.files.push({ path: cached.localPath, pageId: cached.id, status: "error", message });
    result.errors++;
    log(opts, `    ✗ error: ${message}`);
  }
}

async function pushCreated(
  opts: PushOptions,
  provider: RemoteProvider,
  scope: ResolvedScope,
  cache: CloneCache,
  relPath: string,
  rawContent: string,
  title: string,
  result: PushSyncResult,
): Promise<void> {
  log(opts, `  creating ${relPath}...`);
  try {
    const parentId = findParentId(relPath, cache, provider.name, scope.key);
    const entry = await provider.create?.(scope, parentId, title, rawContent);
    if (!entry) throw new Error("Provider create returned no entry");

    cache.upsert(provider.name, scope, entry, relPath, contentHash(rawContent));
    result.files.push({ path: relPath, pageId: entry.id, status: "created", newVersion: entry.version });
    result.created++;
    log(opts, `    ✓ created (id: ${entry.id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.files.push({ path: relPath, pageId: "", status: "error", message });
    result.errors++;
    log(opts, `    ✗ error: ${message}`);
  }
}

async function pushDeleted(
  opts: PushOptions,
  provider: RemoteProvider,
  scope: ResolvedScope,
  cache: CloneCache,
  cached: CachedEntry,
  result: PushSyncResult,
): Promise<void> {
  log(opts, `  deleting ${cached.localPath}...`);
  try {
    await provider.delete?.(scope, cached.id);
    cache.remove(provider.name, scope.cloudId, cached.id);
    result.files.push({ path: cached.localPath, pageId: cached.id, status: "deleted" });
    result.deleted++;
    log(opts, `    ✓ deleted (was id: ${cached.id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.files.push({ path: cached.localPath, pageId: cached.id, status: "error", message });
    result.errors++;
    log(opts, `    ✗ error: ${message}`);
  }
}
