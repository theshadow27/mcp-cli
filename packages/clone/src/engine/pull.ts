/**
 * Pull engine — incremental sync from remote to local git repo.
 *
 * Fast path (incremental):
 *   1. Read last_synced from cache
 *   2. Query provider.changes(since) for pages modified since last sync
 *   3. Fetch only changed pages, write/update files
 *   4. Git add + commit, update last_synced
 *
 * Slow path (full sync, used on first pull or with --full):
 *   1. Fetch all pages via provider.list()
 *   2. Diff against cache to find created/updated/deleted
 *   3. Write/update/delete files, git add + commit
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TruncatedChangesError } from "../providers/confluence";
import type { ChangeEvent, RemoteEntry, RemoteProvider, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";

export interface PullOptions {
  /** Root directory of the cloned repo. */
  repoDir: string;
  /** Provider instance. */
  provider: RemoteProvider;
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Force full sync instead of incremental. */
  full?: boolean;
}

export interface PullResult {
  /** Number of pages updated. */
  updated: number;
  /** Number of new pages created. */
  created: number;
  /** Number of pages deleted. */
  deleted: number;
  /** Whether a new commit was created. */
  committed: boolean;
  /** Whether incremental sync was used. */
  incremental: boolean;
}

function log(opts: PullOptions, msg: string): void {
  if (opts.onProgress) opts.onProgress(msg);
  else process.stderr.write(`${msg}\n`);
}

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

export async function pull(opts: PullOptions): Promise<PullResult> {
  const { repoDir, provider, full = false } = opts;
  const cachePath = join(repoDir, ".clone", "cache.sqlite");

  if (!existsSync(cachePath)) {
    throw new Error(`No cache found at ${cachePath}. Is this a cloned repo? Use "mcx vfs clone" first.`);
  }

  const cache = new CloneCache(cachePath);
  const result: PullResult = { updated: 0, created: 0, deleted: 0, committed: false, incremental: false };

  try {
    // ── Load scope from cache ────────────────────────────────
    const scope = cache.findFirstScope(provider.name);
    if (!scope) {
      throw new Error("No scope found in cache. Was this repo cloned with mcx vfs clone?");
    }

    log(opts, `Pulling ${provider.name}/${scope.key}...`);

    // ── Decide: incremental or full ──────────────────────────
    const lastSynced = cache.getLastSynced(provider.name, scope.key);
    const canIncremental = !full && lastSynced && provider.changes;

    if (canIncremental) {
      try {
        await incrementalPull(opts, cache, scope, lastSynced, result);
      } catch (err) {
        if (err instanceof TruncatedChangesError) {
          log(opts, `  ${err.message}`);
          result.incremental = false;
          await fullPull(opts, cache, scope, result);
        } else {
          throw err;
        }
      }
    } else {
      if (!full && lastSynced) {
        log(opts, "Provider doesn't support incremental sync, falling back to full sync.");
      }
      await fullPull(opts, cache, scope, result);
    }

    // ── Git commit ───────────────────────────────────────────
    const totalChanges = result.created + result.updated + result.deleted;
    if (totalChanges > 0) {
      const gitOpts = { cwd: repoDir, stdio: "pipe" as const };
      execSync("git add -A", gitOpts);

      try {
        execSync("git diff --cached --quiet", gitOpts);
        log(opts, "No file changes to commit.");
      } catch {
        const parts: string[] = [];
        if (result.created > 0) parts.push(`${result.created} new`);
        if (result.updated > 0) parts.push(`${result.updated} updated`);
        if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
        const mode = result.incremental ? "incremental" : "full";
        const commitMsg = `Pull ${provider.name}/${scope.key} (${mode}): ${parts.join(", ")}`;
        spawnSync("git", ["commit", "-m", commitMsg], gitOpts);
        result.committed = true;
        log(opts, `  → committed: ${commitMsg}`);
      }
    }

    // ── Update last_synced (after commit so interrupted syncs don't advance watermark) ──
    cache.updateLastSynced(provider.name, scope.key);

    if (result.created + result.updated + result.deleted === 0) {
      log(opts, "Already up to date.");
    } else {
      log(opts, `\nPull complete. ${result.created} new, ${result.updated} updated, ${result.deleted} deleted.`);
    }
  } finally {
    cache.close();
  }

  return result;
}

/** Incremental pull — only fetch pages changed since last sync. */
async function incrementalPull(
  opts: PullOptions,
  cache: CloneCache,
  scope: ResolvedScope,
  since: string,
  result: PullResult,
): Promise<void> {
  const { repoDir, provider } = opts;
  result.incremental = true;

  log(opts, `Incremental sync (changes since ${since})...`);

  const cachedEntries = cache.listScope(provider.name, scope.key);
  const cachedById = new Map(cachedEntries.map((e) => [e.id, e]));

  // Collect all changes — provider.changes is guaranteed to exist here
  const changes: ChangeEvent[] = [];
  const changesIter = provider.changes?.(scope, since);
  if (!changesIter) return;
  for await (const change of changesIter) {
    changes.push(change);
  }

  if (changes.length === 0) {
    log(opts, "  → no changes detected");
    return;
  }

  log(opts, `  → ${changes.length} change(s) detected`);

  // For path computation on new/updated entries, we need the full entry list.
  // For incremental, we use cached paths for existing entries and compute new ones
  // using the cached entries as context.
  const allCachedAsEntries: RemoteEntry[] = cachedEntries.map((c) => ({
    id: c.id,
    title: c.title,
    parentId: c.parentId ?? undefined,
    version: c.version,
    lastModified: c.lastModified,
    metadata: {},
  }));

  for (const change of changes) {
    const { entry } = change;

    if (change.type === "deleted") {
      const cached = cachedById.get(entry.id);
      if (cached) {
        const absPath = join(repoDir, cached.localPath);
        if (existsSync(absPath)) unlinkSync(absPath);
        cache.remove(provider.name, scope.cloudId, entry.id);
        result.deleted++;
        log(opts, `  - ${cached.localPath} (deleted)`);
      }
      continue;
    }

    // Created or updated — fetch content if not inline
    let content = entry.content;
    if (content == null) {
      const fetched = await provider.fetch(scope, entry.id);
      content = fetched.content;
    }

    // Compute path — use cached entries + this entry for context
    const entriesForPath = [...allCachedAsEntries.filter((e) => e.id !== entry.id), entry];
    const relPath = provider.toPath(entry, entriesForPath);
    const absPath = join(repoDir, relPath);

    const fm = provider.frontmatter(entry, scope);
    const withFrontmatter = injectFrontmatter(content, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");

    cache.upsert(provider.name, scope, entry, relPath, contentHash(content));

    const isNew = !cachedById.has(entry.id);
    if (isNew) {
      result.created++;
      log(opts, `  + ${relPath} (new)`);
    } else {
      // Handle path change (title rename)
      const oldCached = cachedById.get(entry.id);
      if (oldCached && oldCached.localPath !== relPath) {
        const oldAbsPath = join(repoDir, oldCached.localPath);
        if (existsSync(oldAbsPath)) unlinkSync(oldAbsPath);
        log(opts, `  ~ ${oldCached.localPath} → ${relPath} (renamed + updated)`);
      } else {
        log(opts, `  ~ ${relPath} (updated)`);
      }
      result.updated++;
    }
  }
}

/** Full pull — fetch all pages and diff against cache. */
async function fullPull(opts: PullOptions, cache: CloneCache, scope: ResolvedScope, result: PullResult): Promise<void> {
  const { repoDir, provider } = opts;

  log(opts, "Full sync...");

  const cachedEntries = cache.listScope(provider.name, scope.key);
  const cachedById = new Map(cachedEntries.map((e) => [e.id, e]));

  // Fetch all remote entries
  const remoteEntries: RemoteEntry[] = [];
  const remoteContentMap = new Map<string, string>();
  let fetched = 0;

  for await (const entry of provider.list(scope)) {
    remoteEntries.push(entry);
    if (entry.content != null) {
      remoteContentMap.set(entry.id, entry.content);
    }
    fetched++;
    if (fetched % 100 === 0) log(opts, `  ${fetched} pages...`);
  }

  log(opts, `  → ${remoteEntries.length} remote pages`);

  const remoteById = new Map(remoteEntries.map((e) => [e.id, e]));

  // Diff
  const toUpdate: RemoteEntry[] = [];
  const toCreate: RemoteEntry[] = [];
  const toDelete: string[] = [];

  for (const remote of remoteEntries) {
    const cached = cachedById.get(remote.id);
    if (!cached) {
      toCreate.push(remote);
    } else if (remote.version > cached.version || remote.lastModified > cached.lastModified) {
      toUpdate.push(remote);
    }
  }

  for (const cached of cachedEntries) {
    if (!remoteById.has(cached.id)) {
      toDelete.push(cached.id);
    }
  }

  const totalChanges = toCreate.length + toUpdate.length + toDelete.length;
  if (totalChanges === 0) return;

  log(opts, `Changes: ${toCreate.length} new, ${toUpdate.length} updated, ${toDelete.length} deleted`);

  // Fetch content for entries without inline content
  const needsFetch = [...toCreate, ...toUpdate].filter((e) => !remoteContentMap.has(e.id));
  if (needsFetch.length > 0) {
    log(opts, `Fetching content for ${needsFetch.length} pages...`);
    const BATCH_SIZE = 10;
    for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
      const batch = needsFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (entry) => {
          const f = await provider.fetch(scope, entry.id);
          return { id: entry.id, content: f.content };
        }),
      );
      for (const r of results) {
        remoteContentMap.set(r.id, r.content);
      }
    }
  }

  // Apply changes
  for (const entry of [...toCreate, ...toUpdate]) {
    const relPath = provider.toPath(entry, remoteEntries);
    const absPath = join(repoDir, relPath);
    const content = remoteContentMap.get(entry.id) ?? "";
    const fm = provider.frontmatter(entry, scope);
    const withFrontmatter = injectFrontmatter(content, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");
    cache.upsert(provider.name, scope, entry, relPath, contentHash(content));

    if (cachedById.has(entry.id)) {
      const oldCached = cachedById.get(entry.id);
      if (oldCached && oldCached.localPath !== relPath) {
        const oldAbsPath = join(repoDir, oldCached.localPath);
        if (existsSync(oldAbsPath)) unlinkSync(oldAbsPath);
      }
      result.updated++;
    } else {
      result.created++;
    }
  }

  for (const id of toDelete) {
    const cached = cachedById.get(id);
    if (cached) {
      const absPath = join(repoDir, cached.localPath);
      if (existsSync(absPath)) unlinkSync(absPath);
      cache.remove(provider.name, scope.cloudId, id);
      result.deleted++;
    }
  }
}
