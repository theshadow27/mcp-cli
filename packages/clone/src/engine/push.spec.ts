import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteEntry, RemoteProvider, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";
import { push } from "./push";

const TMP = join(import.meta.dir, "__test_push_tmp__");

function makeScope(key = "TEST", cloudId = "cloud-123"): ResolvedScope {
  return { key, cloudId, resolved: { spaceId: "space-456" } };
}

function makeEntry(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    id: "page-1",
    title: "My Page",
    version: 1,
    lastModified: "2026-01-01T00:00:00Z",
    metadata: {},
    ...overrides,
  };
}

/** Create a stub provider with configurable push/create/delete handlers. */
function makeProvider(overrides: Partial<RemoteProvider> = {}): RemoteProvider {
  return {
    name: "test",
    resolveScope: async (s) => ({ ...s, cloudId: s.cloudId ?? "cloud-123", resolved: {} }),
    list: async function* () {},
    fetch: async (_s, id) => ({ content: "", entry: makeEntry({ id }) }),
    toPath: (entry) => `${entry.title}.md`,
    frontmatter: (entry) => ({ id: entry.id, title: entry.title }),
    ...overrides,
  };
}

let repoDir: string;
let cachePath: string;
let cache: CloneCache;
let scope: ResolvedScope;

beforeEach(() => {
  repoDir = join(TMP, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, ".clone"), { recursive: true });
  cachePath = join(repoDir, ".clone", "cache.sqlite");
  cache = new CloneCache(cachePath);
  scope = makeScope();
  cache.saveScopeMeta("test", scope);
});

afterEach(() => {
  cache.close();
  rmSync(TMP, { recursive: true, force: true });
});

/** Write a markdown file with frontmatter to the repo. */
function writeFile(relPath: string, body: string, fm: Record<string, unknown> = {}): void {
  const absPath = join(repoDir, relPath);
  mkdirSync(join(absPath, ".."), { recursive: true });
  const content = Object.keys(fm).length > 0 ? injectFrontmatter(body, fm) : body;
  writeFileSync(absPath, content, "utf-8");
}

/** Seed the cache with an entry and write the corresponding file. */
function seedCachedFile(id: string, relPath: string, body: string, version = 1): void {
  const hash = Bun.hash(body).toString(16);
  cache.upsert("test", scope, makeEntry({ id, title: id, version }), relPath, hash);
  writeFile(relPath, body, { id, version });
}

describe("push", () => {
  test("throws when no cache exists", async () => {
    const emptyDir = join(TMP, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const provider = makeProvider();
    await expect(push({ repoDir: emptyDir, provider })).rejects.toThrow("No cache found");
  });

  test("throws when no scope in cache", async () => {
    // Create a fresh cache with no scope metadata
    const noScopeDir = join(TMP, "no-scope");
    mkdirSync(join(noScopeDir, ".clone"), { recursive: true });
    const noScopeCache = new CloneCache(join(noScopeDir, ".clone", "cache.sqlite"));
    noScopeCache.close();

    const provider = makeProvider();
    await expect(push({ repoDir: noScopeDir, provider })).rejects.toThrow("No scope found");
  });

  test("reports nothing to push when files match cache", async () => {
    seedCachedFile("p1", "page-one.md", "Hello world");
    cache.close();

    const provider = makeProvider();
    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.pushed).toBe(0);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  test("detects modified files by content hash", async () => {
    seedCachedFile("p1", "page-one.md", "Original content");
    // Overwrite with different content
    writeFile("page-one.md", "Modified content", { id: "p1", version: 1 });
    cache.close();

    const pushed: Array<{ id: string; content: string; baseVersion: number }> = [];
    const provider = makeProvider({
      push: async (_scope, id, content, baseVersion) => {
        pushed.push({ id, content, baseVersion });
        return { ok: true, newVersion: baseVersion + 1 };
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.pushed).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("pushed");
    expect(result.files[0].newVersion).toBe(2);

    expect(pushed).toHaveLength(1);
    expect(pushed[0].id).toBe("p1");
    expect(pushed[0].content).toBe("Modified content");
    expect(pushed[0].baseVersion).toBe(1);
  });

  test("detects deleted files (in cache but not on disk)", async () => {
    // Seed cache entry but don't write file
    const hash = Bun.hash("content").toString(16);
    cache.upsert("test", scope, makeEntry({ id: "p1", title: "Gone" }), "gone.md", hash);
    cache.close();

    const deletedIds: string[] = [];
    const provider = makeProvider({
      delete: async (_scope, id) => {
        deletedIds.push(id);
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.deleted).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("deleted");
    expect(deletedIds).toEqual(["p1"]);
  });

  test("detects new files when --create is set", async () => {
    writeFile("new-page.md", "Brand new content");
    cache.close();

    const createdPages: Array<{ title: string; content: string }> = [];
    const provider = makeProvider({
      create: async (_scope, _parentId, title, content) => {
        createdPages.push({ title, content });
        return makeEntry({ id: "new-1", title, version: 1 });
      },
    });

    const result = await push({ repoDir, provider, create: true, onProgress: () => {} });
    expect(result.created).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("created");
    expect(createdPages[0].title).toBe("new-page");
    expect(createdPages[0].content).toBe("Brand new content");
  });

  test("skips new files when --create is not set", async () => {
    writeFile("new-page.md", "Brand new content");
    cache.close();

    const provider = makeProvider({
      create: async () => makeEntry(),
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.created).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  test("dry-run categorizes changes but does not push", async () => {
    seedCachedFile("p1", "page-one.md", "Original");
    writeFile("page-one.md", "Modified", { id: "p1", version: 1 });
    writeFile("brand-new.md", "New content");
    // Deleted: in cache but not on disk
    const hash = Bun.hash("gone").toString(16);
    cache.upsert("test", scope, makeEntry({ id: "p2", title: "Gone" }), "gone.md", hash);
    cache.close();

    let pushCalled = false;
    let createCalled = false;
    let deleteCalled = false;
    const provider = makeProvider({
      push: async () => {
        pushCalled = true;
        return { ok: true };
      },
      create: async () => {
        createCalled = true;
        return makeEntry();
      },
      delete: async () => {
        deleteCalled = true;
      },
    });

    const result = await push({ repoDir, provider, dryRun: true, create: true, onProgress: () => {} });

    // All files should be "skipped"
    expect(result.files.every((f) => f.status === "skipped")).toBe(true);
    expect(result.files).toHaveLength(3);
    // No actual calls made
    expect(pushCalled).toBe(false);
    expect(createCalled).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  test("handles push conflict (version mismatch)", async () => {
    seedCachedFile("p1", "page-one.md", "Original");
    writeFile("page-one.md", "Modified", { id: "p1", version: 1 });
    cache.close();

    const provider = makeProvider({
      push: async () => ({ ok: false, error: "version conflict: expected 2, got 3" }),
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.files[0].status).toBe("conflict");
  });

  test("handles push error (non-conflict)", async () => {
    seedCachedFile("p1", "page-one.md", "Original");
    writeFile("page-one.md", "Modified", { id: "p1", version: 1 });
    cache.close();

    const provider = makeProvider({
      push: async () => ({ ok: false, error: "network timeout" }),
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(result.files[0].status).toBe("error");
  });

  test("handles push exception", async () => {
    seedCachedFile("p1", "page-one.md", "Original");
    writeFile("page-one.md", "Modified", { id: "p1", version: 1 });
    cache.close();

    const provider = makeProvider({
      push: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.errors).toBe(1);
    expect(result.files[0].status).toBe("error");
    expect(result.files[0].message).toBe("connection refused");
  });

  test("titleFromPath derives title from _index.md parent dir", async () => {
    writeFile("Engineering/_index.md", "Index content");
    cache.close();

    const createdPages: Array<{ title: string }> = [];
    const provider = makeProvider({
      create: async (_scope, _parentId, title, _content) => {
        createdPages.push({ title });
        return makeEntry({ id: "idx-1", title, version: 1 });
      },
    });

    const result = await push({ repoDir, provider, create: true, onProgress: () => {} });
    expect(result.created).toBe(1);
    expect(createdPages[0].title).toBe("Engineering");
  });

  test("findParentId looks up _index.md in parent directory", async () => {
    // Seed parent _index.md
    seedCachedFile("parent-1", "Engineering/_index.md", "Parent page");
    // Create child file (not cached — it's new)
    writeFile("Engineering/child-page.md", "Child content");
    cache.close();

    const createdPages: Array<{ parentId: string | undefined }> = [];
    const provider = makeProvider({
      create: async (_scope, parentId, _title, _content) => {
        createdPages.push({ parentId });
        return makeEntry({ id: "child-1", version: 1 });
      },
    });

    const result = await push({ repoDir, provider, create: true, onProgress: () => {} });
    expect(result.created).toBe(1);
    expect(createdPages[0].parentId).toBe("parent-1");
  });

  test("excludes .git and .clone directories from scanning", async () => {
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "HEAD.md"), "not a page");
    mkdirSync(join(repoDir, ".clone"), { recursive: true });
    writeFileSync(join(repoDir, ".clone", "internal.md"), "not a page");
    writeFileSync(join(repoDir, ".gitignore"), ".clone/");
    cache.close();

    const provider = makeProvider();
    const result = await push({ repoDir, provider, create: true, onProgress: () => {} });
    // None of the excluded files should be detected as new
    expect(result.files).toHaveLength(0);
  });

  test("skips create when provider has no create method", async () => {
    writeFile("new-page.md", "New content");
    cache.close();

    const provider = makeProvider();
    // Remove create from provider
    (provider as unknown as Record<string, unknown>).create = undefined;

    const result = await push({ repoDir, provider, create: true, onProgress: () => {} });
    // File detected but provider can't create, so skipped
    expect(result.created).toBe(0);
  });

  test("skips delete when provider has no delete method", async () => {
    const hash = Bun.hash("content").toString(16);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "gone.md", hash);
    cache.close();

    const provider = makeProvider();
    (provider as unknown as Record<string, unknown>).delete = undefined;

    const result = await push({ repoDir, provider, onProgress: () => {} });
    expect(result.deleted).toBe(0);
  });
});
