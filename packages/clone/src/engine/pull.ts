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
import { computeDepth } from "./clone";
import { STUB_BODY } from "./constants";
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
  /** Maximum hierarchy depth. 0 = unlimited (deepens shallow clones). */
  depth?: number;
}

export interface PullResult {
  /** Number of pages updated. */
  updated: number;
  /** Number of new pages created. */
  created: number;
  /** Number of pages deleted. */
  deleted: number;
  /** Number of stubs replaced with full content (deepened). */
  deepened: number;
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
  const result: PullResult = { updated: 0, created: 0, deleted: 0, deepened: 0, committed: false, incremental: false };

  try {
    // ── Load scope from cache ────────────────────────────────
    const scope = cache.findFirstScope(provider.name);
    if (!scope) {
      throw new Error("No scope found in cache. Was this repo cloned with mcx vfs clone?");
    }

    log(opts, `Pulling ${provider.name}/${scope.key}...`);

    // ── Decide depth ─────────────────────────────────────────
    // If user specifies --depth, use it. Otherwise, use the stored clone depth.
    // Pull without --depth on a shallow clone deepens (fetches everything).
    const { depth: userDepth = 0 } = opts;
    const storedDepth = cache.getCloneDepth(provider.name, scope.key);
    const hasStubs = cache.countStubs(provider.name, scope.key) > 0;
    // If user didn't specify depth and there are stubs, deepen (depth=0 means unlimited)
    const effectiveDepth = userDepth > 0 ? userDepth : hasStubs ? 0 : storedDepth;
    const isDeepening = hasStubs && effectiveDepth === 0;

    // Re-shallowing (e.g. pull --depth 1 on a depth-2 clone) updates stored depth
    // but does NOT remove content already on disk for deeper pages. Those pages become
    // invisible to the depth system but remain as full files.
    if (userDepth > 0 && storedDepth > 0 && userDepth < storedDepth) {
      log(
        opts,
        `Warning: re-shallowing from depth ${storedDepth} to ${userDepth}. Pages already fetched beyond depth ${userDepth} will remain on disk.`,
      );
    }

    if (isDeepening) {
      log(opts, "Deepening shallow clone — fetching all pages (this may take a while)...");
    }

    // ── Decide: incremental or full ──────────────────────────
    const lastSynced = cache.getLastSynced(provider.name, scope.key);
    // Force full sync when deepening (stubs need to be replaced)
    const forceFullForDeepen = isDeepening || (effectiveDepth !== storedDepth && storedDepth > 0);
    const canIncremental = !full && !forceFullForDeepen && lastSynced && provider.changes;

    if (canIncremental) {
      try {
        await incrementalPull(opts, cache, scope, lastSynced, result, effectiveDepth);
      } catch (err) {
        if (err instanceof TruncatedChangesError) {
          log(opts, `  ${err.message}`);
          result.incremental = false;
          await fullPull(opts, cache, scope, result, effectiveDepth);
        } else {
          throw err;
        }
      }
    } else {
      if (!full && !forceFullForDeepen && lastSynced) {
        log(opts, "Provider doesn't support incremental sync, falling back to full sync.");
      }
      await fullPull(opts, cache, scope, result, effectiveDepth);
    }

    // ── Update stored depth if it changed ─────────────────────
    if (effectiveDepth !== storedDepth) {
      // 0 = unlimited depth — strip the key rather than storing 0
      const updatedResolved = { ...scope, resolved: { ...scope.resolved, cloneDepth: effectiveDepth || undefined } };
      cache.saveScopeMeta(provider.name, updatedResolved);
    }

    // ── Git commit ───────────────────────────────────────────
    const totalChanges = result.created + result.updated + result.deleted + result.deepened;
    if (totalChanges > 0) {
      // Strip GIT_* env vars so inherited env (e.g. from git hooks) doesn't
      // redirect git commands to the parent repo.
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith("GIT_") && v !== undefined) cleanEnv[k] = v;
      }
      const gitOpts = { cwd: repoDir, stdio: "pipe" as const, env: cleanEnv };
      execSync("git add -A", gitOpts);

      try {
        execSync("git diff --cached --quiet", gitOpts);
        log(opts, "No file changes to commit.");
      } catch {
        const parts: string[] = [];
        if (result.created > 0) parts.push(`${result.created} new`);
        if (result.updated > 0) parts.push(`${result.updated} updated`);
        if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
        if (result.deepened > 0) parts.push(`${result.deepened} deepened`);
        const mode = result.incremental ? "incremental" : "full";
        const commitMsg = `Pull ${provider.name}/${scope.key} (${mode}): ${parts.join(", ")}`;
        spawnSync("git", ["commit", "-m", commitMsg], gitOpts);
        result.committed = true;
        log(opts, `  → committed: ${commitMsg}`);
      }
    }

    // ── Update last_synced (after commit so interrupted syncs don't advance watermark) ──
    cache.updateLastSynced(provider.name, scope.key);

    if (totalChanges === 0) {
      log(opts, "Already up to date.");
    } else {
      const summary = [
        result.created > 0 ? `${result.created} new` : null,
        result.updated > 0 ? `${result.updated} updated` : null,
        result.deleted > 0 ? `${result.deleted} deleted` : null,
        result.deepened > 0 ? `${result.deepened} deepened` : null,
      ]
        .filter(Boolean)
        .join(", ");
      log(opts, `\nPull complete. ${summary}.`);
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
  effectiveDepth = 0,
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

  // Build depth map for depth-filtered incremental sync. Include changed entries
  // so new pages get correct parent context for depth computation.
  const allEntriesForDepth = new Map<string, RemoteEntry>(allCachedAsEntries.map((e) => [e.id, e]));
  for (const change of changes) {
    if (change.type !== "deleted") {
      allEntriesForDepth.set(change.entry.id, change.entry);
    }
  }

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

    // Enforce depth limit: new pages beyond depth get written as stubs so the
    // depth invariant doesn't erode silently when incremental sync is the hot path.
    const entryDepth = effectiveDepth > 0 ? computeDepth(entry, allEntriesForDepth) : 1;
    const excluded = effectiveDepth > 0 && entryDepth > effectiveDepth;

    // Compute path — use cached entries + this entry for context
    const entriesForPath = [...allCachedAsEntries.filter((e) => e.id !== entry.id), entry];
    const relPath = provider.toPath(entry, entriesForPath);
    const absPath = join(repoDir, relPath);

    if (excluded) {
      const fm = { ...provider.frontmatter(entry, scope), stub: true };
      const withFrontmatter = injectFrontmatter(STUB_BODY, fm);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, withFrontmatter, "utf-8");
      cache.upsert(provider.name, scope, entry, relPath, null, true);

      if (!cachedById.has(entry.id)) {
        log(opts, `  + ${relPath} (stub — depth limit)`);
      }
      continue;
    }

    // Included — fetch content if not inline
    let content = entry.content;
    if (content == null) {
      const fetched = await provider.fetch(scope, entry.id);
      content = fetched.content;
    }

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
async function fullPull(
  opts: PullOptions,
  cache: CloneCache,
  scope: ResolvedScope,
  result: PullResult,
  effectiveDepth = 0,
): Promise<void> {
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

  // Warn when deepening will fetch many pages
  const stubCount = cachedEntries.filter((e) => e.isStub).length;
  if (stubCount > 0 && effectiveDepth === 0) {
    log(opts, `  Deepening: will fetch content for ${remoteEntries.length} pages (replacing ${stubCount} stubs)...`);
  }

  // Compute depth map if depth filtering is active
  const entryById = new Map(remoteEntries.map((e) => [e.id, e]));
  const depthMap = new Map<string, number>();
  if (effectiveDepth > 0) {
    for (const entry of remoteEntries) {
      depthMap.set(entry.id, computeDepth(entry, entryById));
    }
  }

  const isIncluded = (id: string) => effectiveDepth <= 0 || (depthMap.get(id) ?? 1) <= effectiveDepth;
  const isStubEntry = (id: string) => effectiveDepth > 0 && !isIncluded(id);

  const remoteById = new Map(remoteEntries.map((e) => [e.id, e]));

  // Diff — categorize into full entries, stubs, and deletions
  const toUpdate: RemoteEntry[] = [];
  const toCreate: RemoteEntry[] = [];
  const toDeepen: RemoteEntry[] = []; // stubs being replaced with full content
  const toStub: RemoteEntry[] = []; // entries that should become stubs (new depth-limited entries)
  const toDelete: string[] = [];

  for (const remote of remoteEntries) {
    const cached = cachedById.get(remote.id);
    const included = isIncluded(remote.id);

    if (!cached) {
      if (included) {
        toCreate.push(remote);
      } else {
        toStub.push(remote);
      }
    } else if (cached.isStub && included) {
      // Was a stub, now included (deepening)
      toDeepen.push(remote);
    } else if (!cached.isStub && isStubEntry(remote.id)) {
      // Was included, now excluded (re-shallowing) — keep as-is, don't downgrade
    } else if (included && (remote.version > cached.version || remote.lastModified > cached.lastModified)) {
      toUpdate.push(remote);
    }
  }

  for (const cached of cachedEntries) {
    if (!remoteById.has(cached.id)) {
      toDelete.push(cached.id);
    }
  }

  const totalChanges = toCreate.length + toUpdate.length + toDelete.length + toDeepen.length + toStub.length;
  if (totalChanges === 0) return;

  const changeParts = [
    toCreate.length > 0 ? `${toCreate.length} new` : null,
    toUpdate.length > 0 ? `${toUpdate.length} updated` : null,
    toDelete.length > 0 ? `${toDelete.length} deleted` : null,
    toDeepen.length > 0 ? `${toDeepen.length} to deepen` : null,
    toStub.length > 0 ? `${toStub.length} stubs` : null,
  ]
    .filter(Boolean)
    .join(", ");
  log(opts, `Changes: ${changeParts}`);

  // Fetch content for included entries without inline content
  const needsFetch = [...toCreate, ...toUpdate, ...toDeepen].filter((e) => !remoteContentMap.has(e.id));
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

  // Apply full-content changes
  for (const entry of [...toCreate, ...toUpdate, ...toDeepen]) {
    const relPath = provider.toPath(entry, remoteEntries);
    const absPath = join(repoDir, relPath);
    const content = remoteContentMap.get(entry.id) ?? "";
    const fm = provider.frontmatter(entry, scope);
    const withFrontmatter = injectFrontmatter(content, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");
    cache.upsert(provider.name, scope, entry, relPath, contentHash(content));

    if (toDeepen.includes(entry)) {
      const oldCached = cachedById.get(entry.id);
      if (oldCached && oldCached.localPath !== relPath) {
        const oldAbsPath = join(repoDir, oldCached.localPath);
        if (existsSync(oldAbsPath)) unlinkSync(oldAbsPath);
      }
      result.deepened++;
    } else if (cachedById.has(entry.id)) {
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

  // Write stubs for new depth-limited entries
  for (const entry of toStub) {
    const relPath = provider.toPath(entry, remoteEntries);
    const absPath = join(repoDir, relPath);
    const fm = { ...provider.frontmatter(entry, scope), stub: true };
    const withFrontmatter = injectFrontmatter(STUB_BODY, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");
    cache.upsert(provider.name, scope, entry, relPath, null, true);
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
