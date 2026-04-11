import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteEntry, RemoteProvider, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";
import { push } from "./push";

const TMP = join(import.meta.dir, "__test_push_tmp__");

function makeScope(key = "TEST", cloudId = "cloud-123"): ResolvedScope {
  return {
    key,
    cloudId,
    resolved: { spaceId: "space-456", spaceName: "Test Space", homepageId: "1", baseUrl: "https://example.com" },
  };
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

/** Create a stub RemoteProvider for testing. */
function makeProvider(overrides: Partial<RemoteProvider> = {}): RemoteProvider {
  return {
    name: "test",
    resolveScope: async (s) => ({ ...s, cloudId: s.cloudId ?? "cloud-123", resolved: {} }),
    list: async function* () {},
    fetch: async (_scope, _id) => ({ content: "", entry: makeEntry() }),
    toPath: (entry) => `${entry.title}.md`,
    frontmatter: () => ({}),
    ...overrides,
  };
}

/** Set up a repo dir with a .clone/cache.sqlite and return cache + scope. */
function setupRepo(repoDir: string): { cache: CloneCache; scope: ResolvedScope } {
  mkdirSync(join(repoDir, ".clone"), { recursive: true });
  const cachePath = join(repoDir, ".clone", "cache.sqlite");
  const cache = new CloneCache(cachePath);
  const scope = makeScope();
  cache.saveScopeMeta("test", scope);
  return { cache, scope };
}

/** Write a markdown file with frontmatter to the repo. */
function writeMarkdown(repoDir: string, relPath: string, rawContent: string, fm: Record<string, unknown> = {}): void {
  const absPath = join(repoDir, relPath);
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, injectFrontmatter(rawContent, fm), "utf-8");
}

/** Compute the same hash that push.ts uses internally. */
function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

let repoDir: string;

beforeEach(() => {
  repoDir = join(TMP, `repo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("push", () => {
  test("detects modified files via content hash mismatch", async () => {
    const { cache, scope } = setupRepo(repoDir);
    const entry = makeEntry({ id: "p1", title: "Page One" });

    // Cache has old content hash
    cache.upsert("test", scope, entry, "Page One.md", contentHash("old content"));
    cache.close();

    // Write new content on disk
    writeMarkdown(repoDir, "Page One.md", "new content", { id: "p1" });

    let pushedId: string | undefined;
    let pushedContent: string | undefined;
    const provider = makeProvider({
      push: async (_scope, id, content, _baseVersion) => {
        pushedId = id;
        pushedContent = content;
        return { ok: true, newVersion: 2 };
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.pushed).toBe(1);
    expect(pushedId).toBe("p1");
    expect(pushedContent).toBe("new content");
    expect(result.files[0].status).toBe("pushed");
    expect(result.files[0].newVersion).toBe(2);
  });

  test("detects deleted files (in cache but not on disk)", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "gone.md", contentHash("content"));
    cache.close();

    // Don't write gone.md to disk — it's deleted

    let deletedId: string | undefined;
    const provider = makeProvider({
      delete: async (_scope, id) => {
        deletedId = id;
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.deleted).toBe(1);
    expect(deletedId).toBe("p1");
    expect(result.files[0].status).toBe("deleted");
  });

  test("detects new files when --create is set", async () => {
    const { cache } = setupRepo(repoDir);
    cache.close();

    writeMarkdown(repoDir, "New Page.md", "brand new content");

    let createdTitle: string | undefined;
    let createdContent: string | undefined;
    const provider = makeProvider({
      create: async (_scope, _parentId, title, content) => {
        createdTitle = title;
        createdContent = content;
        return makeEntry({ id: "new-1", title, version: 1 });
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {}, create: true });

    expect(result.created).toBe(1);
    expect(createdTitle).toBe("New Page");
    expect(createdContent).toBe("brand new content");
    expect(result.files[0].status).toBe("created");
  });

  test("skips new files when --create is not set", async () => {
    const { cache } = setupRepo(repoDir);
    cache.close();

    writeMarkdown(repoDir, "New Page.md", "content");

    const provider = makeProvider();
    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.created).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  test("dry run reports changes without pushing", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Page.md", contentHash("old"));
    cache.close();

    writeMarkdown(repoDir, "Page.md", "new content", { id: "p1" });

    let pushCalled = false;
    const provider = makeProvider({
      push: async () => {
        pushCalled = true;
        return { ok: true, newVersion: 2 };
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {}, dryRun: true });

    expect(pushCalled).toBe(false);
    expect(result.pushed).toBe(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("skipped");
    expect(result.files[0].message).toBe("dry run");
  });

  test("handles push conflict", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Page.md", contentHash("old"));
    cache.close();

    writeMarkdown(repoDir, "Page.md", "edited", { id: "p1" });

    const provider = makeProvider({
      push: async () => ({ ok: false, error: "version conflict: expected 1, got 3" }),
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.files[0].status).toBe("conflict");
  });

  test("handles push error (non-conflict)", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Page.md", contentHash("old"));
    cache.close();

    writeMarkdown(repoDir, "Page.md", "edited", { id: "p1" });

    const provider = makeProvider({
      push: async () => ({ ok: false, error: "server unavailable" }),
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(result.files[0].status).toBe("error");
  });

  test("reports nothing to push when content matches", async () => {
    const { cache, scope } = setupRepo(repoDir);
    const raw = "same content";
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Page.md", contentHash(raw));
    cache.close();

    writeMarkdown(repoDir, "Page.md", raw, { id: "p1" });

    const provider = makeProvider();
    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.pushed).toBe(0);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  test("throws when no cache exists", async () => {
    // No .clone/cache.sqlite
    const provider = makeProvider();
    await expect(push({ repoDir, provider })).rejects.toThrow("No cache found");
  });

  test("throws when no scope in cache", async () => {
    // Create cache but don't save scope meta
    mkdirSync(join(repoDir, ".clone"), { recursive: true });
    const cache = new CloneCache(join(repoDir, ".clone", "cache.sqlite"));
    cache.close();

    const provider = makeProvider();
    await expect(push({ repoDir, provider, onProgress: () => {} })).rejects.toThrow("No scope found");
  });

  test("dry run includes new and deleted files", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "deleted.md", contentHash("content"));
    cache.close();

    // deleted.md not on disk, new.md is on disk
    writeMarkdown(repoDir, "new.md", "new content");

    const provider = makeProvider();
    const result = await push({ repoDir, provider, onProgress: () => {}, dryRun: true, create: true });

    const statuses = result.files.map((f) => f.status);
    expect(statuses).toContain("skipped");
    expect(result.files).toHaveLength(2);
  });

  test("excludes .git, .clone, and .gitignore from scan", async () => {
    const { cache } = setupRepo(repoDir);
    cache.close();

    // These should all be ignored
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(repoDir, ".gitignore"), ".clone/");

    const provider = makeProvider();
    const result = await push({ repoDir, provider, onProgress: () => {}, create: true });

    // No files should be detected
    expect(result.files).toHaveLength(0);
  });

  test("_index.md derives title from parent directory name", async () => {
    const { cache } = setupRepo(repoDir);
    cache.close();

    writeMarkdown(repoDir, "Engineering/_index.md", "index content");

    let createdTitle: string | undefined;
    const provider = makeProvider({
      create: async (_scope, _parentId, title, _content) => {
        createdTitle = title;
        return makeEntry({ id: "idx-1", title, version: 1 });
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {}, create: true });

    expect(result.created).toBe(1);
    expect(createdTitle).toBe("Engineering");
  });

  test("findParentId resolves parent from _index.md in cache", async () => {
    const { cache, scope } = setupRepo(repoDir);
    // Parent page cached as _index.md
    cache.upsert("test", scope, makeEntry({ id: "parent-1", title: "Docs" }), "Docs/_index.md", null);
    cache.close();

    // New child page under Docs/
    writeMarkdown(repoDir, "Docs/_index.md", "parent content", { id: "parent-1" });
    writeMarkdown(repoDir, "Docs/Child.md", "child content");

    let parentIdUsed: string | undefined;
    const provider = makeProvider({
      create: async (_scope, parentId, _title, _content) => {
        parentIdUsed = parentId;
        return makeEntry({ id: "child-1", version: 1 });
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {}, create: true });

    expect(result.created).toBe(1);
    expect(parentIdUsed).toBe("parent-1");
  });

  test("provider without push/create/delete skips those operations", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Modified.md", contentHash("old"));
    cache.upsert("test", scope, makeEntry({ id: "p2" }), "Deleted.md", contentHash("content"));
    cache.close();

    writeMarkdown(repoDir, "Modified.md", "new content", { id: "p1" });
    writeMarkdown(repoDir, "New.md", "new file");
    // Deleted.md not on disk

    // Provider with no push/create/delete methods
    const provider = makeProvider({
      push: undefined,
      create: undefined,
      delete: undefined,
    });

    const result = await push({ repoDir, provider, onProgress: () => {}, create: true });

    // Nothing actually pushed — provider doesn't support it
    expect(result.pushed).toBe(0);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test("push exception is caught and recorded as error", async () => {
    const { cache, scope } = setupRepo(repoDir);
    cache.upsert("test", scope, makeEntry({ id: "p1" }), "Page.md", contentHash("old"));
    cache.close();

    writeMarkdown(repoDir, "Page.md", "edited", { id: "p1" });

    const provider = makeProvider({
      push: async () => {
        throw new Error("network timeout");
      },
    });

    const result = await push({ repoDir, provider, onProgress: () => {} });

    expect(result.errors).toBe(1);
    expect(result.files[0].status).toBe("error");
    expect(result.files[0].message).toBe("network timeout");
  });
});
