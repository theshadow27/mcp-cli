/**
 * Push engine — write local changes back to the remote provider.
 *
 * Workflow:
 * 1. Read scope from SQLite cache
 * 2. Find locally changed files (compare content hash vs cache)
 * 3. For each changed file:
 *    a. Strip frontmatter → get raw markdown
 *    b. Look up page ID and version from cache
 *    c. Check for remote version conflicts
 *    d. Push content to provider
 * 4. Update cache with new versions
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
  status: "pushed" | "conflict" | "error" | "skipped";
  message?: string;
  newVersion?: number;
}

export interface PushSyncResult {
  /** Per-file results. */
  files: PushFileResult[];
  /** Number of files successfully pushed. */
  pushed: number;
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

export async function push(opts: PushOptions): Promise<PushSyncResult> {
  const { repoDir, provider, dryRun = false } = opts;
  const cachePath = join(repoDir, ".clone", "cache.sqlite");

  if (!existsSync(cachePath)) {
    throw new Error(`No cache found at ${cachePath}. Is this a cloned repo? Use "mcx clone" first.`);
  }

  if (!provider.push) {
    throw new Error(`Provider "${provider.name}" does not support push.`);
  }

  const cache = new CloneCache(cachePath);
  const result: PushSyncResult = { files: [], pushed: 0, conflicts: 0, errors: 0 };

  try {
    // ── Load scope ───────────────────────────────────────────
    const scope = cache.findFirstScope(provider.name);
    if (!scope) {
      throw new Error("No scope found in cache.");
    }

    log(opts, `Pushing to ${provider.name}/${scope.key}...`);

    // ── Find changed files ───────────────────────────────────
    const cachedEntries = cache.listScope(provider.name, scope.key);
    const changedFiles: Array<{ cached: CachedEntry; localContent: string; rawContent: string }> = [];

    for (const cached of cachedEntries) {
      const absPath = join(repoDir, cached.localPath);
      if (!existsSync(absPath)) continue; // deleted files handled by pull

      const localContent = readFileSync(absPath, "utf-8");
      const { content: rawContent } = stripFrontmatter(localContent);
      const hash = contentHash(rawContent);

      if (hash !== cached.contentHash) {
        changedFiles.push({ cached, localContent, rawContent });
      }
    }

    if (changedFiles.length === 0) {
      log(opts, "Nothing to push. All files match remote.");
      return result;
    }

    log(opts, `${changedFiles.length} file(s) changed locally:`);
    for (const { cached } of changedFiles) {
      log(opts, `  ${cached.localPath}`);
    }

    if (dryRun) {
      log(opts, "\n(dry run — no changes pushed)");
      for (const { cached } of changedFiles) {
        result.files.push({ path: cached.localPath, pageId: cached.id, status: "skipped", message: "dry run" });
      }
      return result;
    }

    // ── Push each changed file ───────────────────────────────
    for (const { cached, rawContent } of changedFiles) {
      log(opts, `  pushing ${cached.localPath}...`);

      try {
        // Check for title change via frontmatter
        const absPath = join(repoDir, cached.localPath);
        const localContent = readFileSync(absPath, "utf-8");
        const { fields } = stripFrontmatter(localContent);
        const newTitle = fields?.title as string | undefined;

        const pushResult = await provider.push(scope, cached.id, rawContent, cached.version);

        if (pushResult.ok) {
          // Update cache with new version
          const newVersion = pushResult.newVersion ?? cached.version + 1;
          cache.upsert(
            provider.name,
            scope,
            {
              id: cached.id,
              title: newTitle ?? cached.title,
              parentId: cached.parentId ?? undefined,
              version: newVersion,
              lastModified: new Date().toISOString(),
              metadata: {},
            },
            cached.localPath,
            contentHash(rawContent),
          );

          result.files.push({
            path: cached.localPath,
            pageId: cached.id,
            status: "pushed",
            newVersion,
          });
          result.pushed++;
          log(opts, `    ✓ pushed (v${cached.version} → v${newVersion})`);
        } else if (pushResult.error?.includes("conflict") || pushResult.error?.includes("version")) {
          result.files.push({
            path: cached.localPath,
            pageId: cached.id,
            status: "conflict",
            message: pushResult.error,
          });
          result.conflicts++;
          log(opts, `    ✗ conflict: ${pushResult.error}`);
        } else {
          result.files.push({
            path: cached.localPath,
            pageId: cached.id,
            status: "error",
            message: pushResult.error,
          });
          result.errors++;
          log(opts, `    ✗ error: ${pushResult.error}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.files.push({
          path: cached.localPath,
          pageId: cached.id,
          status: "error",
          message,
        });
        result.errors++;
        log(opts, `    ✗ error: ${message}`);
      }
    }

    log(opts, `\nPush complete. ${result.pushed} pushed, ${result.conflicts} conflicts, ${result.errors} errors.`);
  } finally {
    cache.close();
  }

  return result;
}
