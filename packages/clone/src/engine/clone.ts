/**
 * Clone engine — orchestrates cloning a remote provider's scope into a local git repo.
 *
 * Workflow:
 * 1. Resolve the scope (space key → spaceId, cloudId)
 * 2. Bulk fetch all pages with content
 * 3. Build directory tree from page hierarchy
 * 4. Write markdown files with frontmatter
 * 5. Initialize git repo with initial commit
 * 6. Populate SQLite cache
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RemoteEntry, RemoteProvider, ResolvedScope, Scope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";

export interface CloneOptions {
  /** Target directory to clone into. */
  targetDir: string;
  /** Provider instance. */
  provider: RemoteProvider;
  /** Scope to clone. */
  scope: Scope;
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Maximum pages to fetch (for testing/debugging). 0 = unlimited. */
  limit?: number;
  /** Maximum hierarchy depth to clone. 0 = unlimited. Depth 1 = root pages only. */
  depth?: number;
}

export interface CloneResult {
  /** Absolute path to the cloned directory. */
  path: string;
  /** Number of pages cloned (full content). */
  pageCount: number;
  /** Number of pages written as stubs (depth-limited). */
  stubCount: number;
  /** Resolved scope info. */
  scope: ResolvedScope;
}

function log(opts: CloneOptions, msg: string): void {
  if (opts.onProgress) opts.onProgress(msg);
  else process.stderr.write(`${msg}\n`);
}

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

/** Compute hierarchy depth of an entry (1 = root, 2 = child of root, etc.). */
export function computeDepth(entry: RemoteEntry, entryById: Map<string, RemoteEntry>): number {
  let depth = 1;
  let current = entry;
  const visited = new Set<string>();
  while (current.parentId && entryById.has(current.parentId)) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const parent = entryById.get(current.parentId);
    if (!parent) break;
    current = parent;
    depth++;
  }
  return depth;
}

const STUB_BODY = `> **Shallow clone stub** — this page was not fetched (depth limit).
>
> Run \`mcx vfs pull\` to fetch all pages, or \`mcx vfs pull --depth N\` with a larger depth.
`;

export async function clone(opts: CloneOptions): Promise<CloneResult> {
  const { targetDir, provider, scope, limit = 0, depth = 0 } = opts;
  const absTarget = resolve(targetDir);

  // ── Preflight checks ───────────────────────────────────────
  if (existsSync(absTarget) && existsSync(join(absTarget, ".git"))) {
    throw new Error(`Directory "${absTarget}" already exists and is a git repo. Use pull to update.`);
  }

  // Detect interrupted clone: directory exists with cache but no git repo
  if (
    existsSync(absTarget) &&
    existsSync(join(absTarget, ".clone", "cache.sqlite")) &&
    !existsSync(join(absTarget, ".git"))
  ) {
    throw new Error(
      `Directory "${absTarget}" contains a partial clone (cache exists but no git repo). Delete the directory and re-run clone, or use "git init && git add -A && git commit" to recover.`,
    );
  }

  // ── Step 1: Resolve scope ──────────────────────────────────
  log(opts, `Resolving scope: ${provider.name}/${scope.key}...`);
  const resolved = await provider.resolveScope(scope);
  const spaceName = resolved.resolved.spaceName as string;
  log(opts, `  → ${spaceName} (cloudId: ${resolved.cloudId}, spaceId: ${resolved.resolved.spaceId})`);

  // ── Step 2: Fetch all pages ────────────────────────────────
  // Providers that support inline content (e.g., Confluence) return content
  // with the listing, avoiding N+1 individual fetch calls.
  log(opts, "Fetching pages...");
  const entries: RemoteEntry[] = [];
  const contentMap = new Map<string, string>();
  let fetched = 0;

  for await (const entry of provider.list(resolved)) {
    entries.push(entry);
    if (entry.content != null) {
      contentMap.set(entry.id, entry.content);
    }
    fetched++;
    if (fetched % 50 === 0) log(opts, `  ${fetched} pages...`);
    if (limit > 0 && fetched >= limit) break;
  }

  log(opts, `  → ${entries.length} pages fetched`);

  // ── Step 2b: Depth filtering ───────────────────────────────
  let includedEntries: RemoteEntry[];
  let stubEntries: RemoteEntry[] = [];

  if (depth > 0) {
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const depthMap = new Map<string, number>();
    for (const entry of entries) {
      depthMap.set(entry.id, computeDepth(entry, entryById));
    }
    includedEntries = entries.filter((e) => (depthMap.get(e.id) ?? 1) <= depth);
    stubEntries = entries.filter((e) => (depthMap.get(e.id) ?? 1) > depth);
    log(opts, `  → depth ${depth}: ${includedEntries.length} included, ${stubEntries.length} stubs`);
  } else {
    includedEntries = entries;
  }

  // Fetch content individually only for included entries that didn't include it inline
  const missingContent = includedEntries.filter((e) => !contentMap.has(e.id));
  if (missingContent.length > 0) {
    log(opts, `Fetching content for ${missingContent.length} pages without inline content...`);
    const BATCH_SIZE = 10;
    let contentFetched = 0;
    for (let i = 0; i < missingContent.length; i += BATCH_SIZE) {
      const batch = missingContent.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (entry) => {
          const result = await provider.fetch(resolved, entry.id);
          return { id: entry.id, content: result.content, entry: result.entry };
        }),
      );
      for (const r of results) {
        contentMap.set(r.id, r.content);
        const idx = includedEntries.findIndex((e) => e.id === r.id);
        if (idx >= 0) includedEntries[idx] = r.entry;
        contentFetched++;
      }
      if (contentFetched % 50 === 0 || contentFetched === missingContent.length) {
        log(opts, `  fetched ${contentFetched}/${missingContent.length} pages`);
      }
    }
  }

  // ── Step 3: Build path map ─────────────────────────────────
  // Use all entries for path computation (stubs need parent context for correct paths)
  log(opts, "Building directory tree...");
  const pathMap = new Map<string, string>();
  for (const entry of entries) {
    const relPath = provider.toPath(entry, entries);
    pathMap.set(entry.id, relPath);
  }

  // ── Step 4: Write files ────────────────────────────────────
  log(opts, "Writing files...");
  mkdirSync(absTarget, { recursive: true });

  let written = 0;
  for (const entry of includedEntries) {
    const relPath = pathMap.get(entry.id) ?? `${entry.id}.md`;
    const absPath = join(absTarget, relPath);
    const content = contentMap.get(entry.id) ?? "";
    const fm = provider.frontmatter(entry, resolved);
    const withFrontmatter = injectFrontmatter(content, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");
    written++;
  }

  // Write stubs for depth-excluded pages
  for (const entry of stubEntries) {
    const relPath = pathMap.get(entry.id) ?? `${entry.id}.md`;
    const absPath = join(absTarget, relPath);
    const fm = { ...provider.frontmatter(entry, resolved), stub: true };
    const withFrontmatter = injectFrontmatter(STUB_BODY, fm);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, withFrontmatter, "utf-8");
  }

  if (stubEntries.length > 0) {
    log(opts, `  → ${written} files + ${stubEntries.length} stubs written`);
  } else {
    log(opts, `  → ${written} files written`);
  }

  // ── Step 5: Populate cache (before git init so interrupted clones can be repaired) ──
  log(opts, "Building cache...");
  const cacheDir = join(absTarget, ".clone");
  const cache = new CloneCache(join(cacheDir, "cache.sqlite"));

  // Store depth in resolved metadata so pull can read it
  const resolvedWithDepth =
    depth > 0 ? { ...resolved, resolved: { ...resolved.resolved, cloneDepth: depth } } : resolved;
  cache.saveScopeMeta(provider.name, resolvedWithDepth);

  for (const entry of includedEntries) {
    const relPath = pathMap.get(entry.id) ?? `${entry.id}.md`;
    const content = contentMap.get(entry.id) ?? "";
    cache.upsert(provider.name, resolvedWithDepth, entry, relPath, contentHash(content));
  }
  for (const entry of stubEntries) {
    const relPath = pathMap.get(entry.id) ?? `${entry.id}.md`;
    cache.upsert(provider.name, resolvedWithDepth, entry, relPath, null, true);
  }
  cache.close();
  log(opts, `  → cache populated (${includedEntries.length} entries, ${stubEntries.length} stubs)`);

  // ── Step 6: Initialize git repo ────────────────────────────
  log(opts, "Initializing git repository...");
  // Strip GIT_* env vars so inherited env (e.g. from git hooks) doesn't
  // redirect git init to the parent repo instead of creating a fresh one.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) cleanEnv[k] = v;
  }
  const gitOpts = { cwd: absTarget, stdio: "pipe" as const, env: cleanEnv };
  execSync("git init", gitOpts);
  // Set user identity for this repo so commits work even in environments
  // without a global git config (e.g. CI runners, fresh machines).
  execSync("git config user.name mcx", gitOpts);
  execSync("git config user.email mcx@localhost", gitOpts);
  execSync("git add -A", gitOpts);

  // Write .gitignore for the cache directory
  writeFileSync(join(absTarget, ".gitignore"), ".clone/\n", "utf-8");
  execSync("git add .gitignore", gitOpts);

  const depthNote = depth > 0 ? `, depth ${depth}` : "";
  const stubNote = stubEntries.length > 0 ? `, ${stubEntries.length} stubs` : "";
  const commitMsg = `Clone ${provider.name}/${scope.key}: ${spaceName} (${includedEntries.length} pages${stubNote}${depthNote})`;
  spawnSync("git", ["commit", "-m", commitMsg, "--allow-empty"], gitOpts);
  log(opts, "  → initial commit created");

  log(opts, `\nDone! Cloned ${includedEntries.length} pages${stubNote} to ${absTarget}`);

  return {
    path: absTarget,
    pageCount: includedEntries.length,
    stubCount: stubEntries.length,
    scope: resolvedWithDepth,
  };
}
