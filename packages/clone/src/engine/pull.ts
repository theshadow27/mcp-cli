/**
 * Pull engine — incremental sync from remote to local git repo.
 *
 * Workflow:
 * 1. Read scope from SQLite cache
 * 2. Detect remote changes (via provider.changes or full list comparison)
 * 3. Fetch updated page content
 * 4. Write/update/delete local files
 * 5. Git add + commit
 * 6. Update cache
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteEntry, RemoteProvider, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";

export interface PullOptions {
  /** Root directory of the cloned repo. */
  repoDir: string;
  /** Provider instance. */
  provider: RemoteProvider;
  /** Progress callback. */
  onProgress?: (message: string) => void;
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
}

function log(opts: PullOptions, msg: string): void {
  if (opts.onProgress) opts.onProgress(msg);
  else process.stderr.write(`${msg}\n`);
}

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

export async function pull(opts: PullOptions): Promise<PullResult> {
  const { repoDir, provider } = opts;
  const cachePath = join(repoDir, ".clone", "cache.sqlite");

  if (!existsSync(cachePath)) {
    throw new Error(`No cache found at ${cachePath}. Is this a cloned repo? Use "mcx clone" first.`);
  }

  const cache = new CloneCache(cachePath);
  const result: PullResult = { updated: 0, created: 0, deleted: 0, committed: false };

  try {
    // ── Load scope from cache ────────────────────────────────
    const scopeMeta = cache.loadScopeMeta(provider.name, "");
    // If empty key, scan for first available scope
    let scope: ResolvedScope;
    if (scopeMeta) {
      scope = scopeMeta;
    } else {
      // Find any scope for this provider
      const allEntries = cache.listScope(provider.name, "");
      if (allEntries.length === 0) {
        // Try to find the scope by querying all scope_meta
        const rawScope = cache.findFirstScope(provider.name);
        if (!rawScope) {
          throw new Error("No scope found in cache. Was this repo cloned with mcx clone?");
        }
        scope = rawScope;
      } else {
        throw new Error("No scope metadata found in cache.");
      }
    }

    log(opts, `Pulling ${provider.name}/${scope.key}...`);

    // ── Get cached entries ───────────────────────────────────
    const cachedEntries = cache.listScope(provider.name, scope.key);
    const cachedById = new Map(cachedEntries.map((e) => [e.id, e]));

    // ── Fetch current remote state ───────────────────────────
    log(opts, "Fetching remote state...");
    const remoteEntries: RemoteEntry[] = [];
    const remoteContentMap = new Map<string, string>();

    for await (const entry of provider.list(scope)) {
      remoteEntries.push(entry);
      if (entry.content != null) {
        remoteContentMap.set(entry.id, entry.content);
      }
    }

    log(opts, `  → ${remoteEntries.length} remote pages`);

    const remoteById = new Map(remoteEntries.map((e) => [e.id, e]));

    // ── Diff: find created, updated, deleted ─────────────────
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
    if (totalChanges === 0) {
      log(opts, "Already up to date.");
      return result;
    }

    log(opts, `Changes: ${toCreate.length} new, ${toUpdate.length} updated, ${toDelete.length} deleted`);

    // ── Fetch content for entries without inline content ──────
    const needsFetch = [...toCreate, ...toUpdate].filter((e) => !remoteContentMap.has(e.id));
    if (needsFetch.length > 0) {
      log(opts, `Fetching content for ${needsFetch.length} pages...`);
      const BATCH_SIZE = 10;
      for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
        const batch = needsFetch.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (entry) => {
            const fetched = await provider.fetch(scope, entry.id);
            return { id: entry.id, content: fetched.content };
          }),
        );
        for (const r of results) {
          remoteContentMap.set(r.id, r.content);
        }
      }
    }

    // ── Apply changes to local files ─────────────────────────
    // Write new and updated files
    for (const entry of [...toCreate, ...toUpdate]) {
      const relPath = provider.toPath(entry, remoteEntries);
      const absPath = join(repoDir, relPath);
      const content = remoteContentMap.get(entry.id) ?? "";
      const fm = provider.frontmatter(entry, scope);
      const withFrontmatter = injectFrontmatter(content, fm);

      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, withFrontmatter, "utf-8");

      // Update cache
      cache.upsert(provider.name, scope, entry, relPath, contentHash(content));

      if (cachedById.has(entry.id)) {
        // If path changed (e.g., title rename), remove old file
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

    // Delete removed files
    for (const id of toDelete) {
      const cached = cachedById.get(id);
      if (cached) {
        const absPath = join(repoDir, cached.localPath);
        if (existsSync(absPath)) unlinkSync(absPath);
        cache.remove(provider.name, scope.cloudId, id);
        result.deleted++;
      }
    }

    // ── Git commit ───────────────────────────────────────────
    const gitOpts = { cwd: repoDir, stdio: "pipe" as const };
    execSync("git add -A", gitOpts);

    // Check if there are actually staged changes
    try {
      execSync("git diff --cached --quiet", gitOpts);
      // No changes staged
      log(opts, "No file changes to commit.");
    } catch {
      // Changes exist
      const parts: string[] = [];
      if (result.created > 0) parts.push(`${result.created} new`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
      const commitMsg = `Pull ${provider.name}/${scope.key}: ${parts.join(", ")}`;
      execSync(`git commit -m ${JSON.stringify(commitMsg)}`, gitOpts);
      result.committed = true;
      log(opts, `  → committed: ${commitMsg}`);
    }

    log(opts, `\nPull complete. ${result.created} new, ${result.updated} updated, ${result.deleted} deleted.`);
  } finally {
    cache.close();
  }

  return result;
}
