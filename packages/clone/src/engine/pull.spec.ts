import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TruncatedChangesError } from "../providers/confluence";
import type { ChangeEvent, RemoteEntry, RemoteProvider, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";
import { injectFrontmatter } from "./frontmatter";
import { pull } from "./pull";

import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "__test_pull_tmp__");

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

function makeProvider(overrides: Partial<RemoteProvider> = {}): RemoteProvider {
  return {
    name: "test",
    resolveScope: async (s) => ({ ...s, cloudId: s.cloudId ?? "cloud-123", resolved: {} }),
    list: async function* () {},
    fetch: async (_scope, _id) => ({ content: "", entry: makeEntry() }),
    toPath: (entry) => `${entry.title}.md`,
    frontmatter: (entry, scope) => ({ id: entry.id, version: entry.version, space: scope.key }),
    ...overrides,
  };
}

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

/** Git env vars that override repo discovery — must be overridden for isolated test repos. */
const GIT_ISOLATION_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/**
 * Build a clean env for git commands that isolates them from parent repos.
 * Uses GIT_CEILING_DIRECTORIES to prevent git from walking above the test dir,
 * and strips GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE from pre-commit hook contexts.
 */
function cleanGitEnv(repoDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && !(GIT_ISOLATION_KEYS as readonly string[]).includes(k)) {
      env[k] = v;
    }
  }
  // Prevent git from discovering repos above the test dir
  env.GIT_CEILING_DIRECTORIES = dirname(repoDir);
  return env;
}

/** Set up a git-initialized repo with a .clone/cache.sqlite. */
function setupRepo(repoDir: string): { cache: CloneCache; scope: ResolvedScope } {
  mkdirSync(join(repoDir, ".clone"), { recursive: true });

  const env = cleanGitEnv(repoDir);
  const gitOpts = { cwd: repoDir, stdio: "pipe" as const, env };
  execSync("git init", gitOpts);
  execSync('git config user.email "test@test.com"', gitOpts);
  execSync('git config user.name "Test"', gitOpts);

  // Write .gitignore and initial commit so git is ready
  writeFileSync(join(repoDir, ".gitignore"), ".clone/\n");
  execSync("git add .gitignore", gitOpts);
  execSync('git commit -m "init"', gitOpts);

  const cachePath = join(repoDir, ".clone", "cache.sqlite");
  const cache = new CloneCache(cachePath);
  const scope = makeScope();
  cache.saveScopeMeta("test", scope);
  return { cache, scope };
}

let repoDir: string;

beforeEach(() => {
  repoDir = join(TMP, `repo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("pull", () => {
  describe("full sync", () => {
    test("creates new files from remote entries", async () => {
      const { cache, scope } = setupRepo(repoDir);
      cache.close();

      const entries: RemoteEntry[] = [
        makeEntry({ id: "p1", title: "Page One", content: "# Page One\n\nContent here." }),
        makeEntry({ id: "p2", title: "Page Two", content: "# Page Two\n\nMore content." }),
      ];

      const provider = makeProvider({
        list: async function* () {
          for (const e of entries) yield e;
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.created).toBe(2);
      expect(result.committed).toBe(true);
      expect(result.incremental).toBe(false);

      // Files should exist with frontmatter
      const file1 = readFileSync(join(repoDir, "Page One.md"), "utf-8");
      expect(file1).toContain("# Page One");
      expect(file1).toContain("id: p1");
    });

    test("updates files when remote version is newer", async () => {
      const { cache, scope } = setupRepo(repoDir);
      const entry = makeEntry({ id: "p1", title: "Page", version: 1 });
      cache.upsert("test", scope, entry, "Page.md", contentHash("old content"));
      cache.close();

      // Write existing file to disk
      const fm = { id: "p1", version: 1, space: "TEST" };
      writeFileSync(join(repoDir, "Page.md"), injectFrontmatter("old content", fm), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      const remoteEntry = makeEntry({ id: "p1", title: "Page", version: 2, content: "updated content" });
      const provider = makeProvider({
        list: async function* () {
          yield remoteEntry;
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.updated).toBe(1);
      expect(result.committed).toBe(true);

      const content = readFileSync(join(repoDir, "Page.md"), "utf-8");
      expect(content).toContain("updated content");
    });

    test("deletes files removed from remote", async () => {
      const { cache, scope } = setupRepo(repoDir);
      cache.upsert("test", scope, makeEntry({ id: "p1", title: "Gone" }), "Gone.md", contentHash("content"));
      cache.close();

      // Write existing file
      writeFileSync(join(repoDir, "Gone.md"), injectFrontmatter("content", { id: "p1" }), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      // Remote returns empty list — page was deleted
      const provider = makeProvider({
        list: async function* () {},
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.deleted).toBe(1);
      expect(result.committed).toBe(true);
      expect(existsSync(join(repoDir, "Gone.md"))).toBe(false);
    });

    test("reports no changes when remote matches cache", async () => {
      const { cache, scope } = setupRepo(repoDir);
      const entry = makeEntry({ id: "p1", title: "Page", version: 1 });
      cache.upsert("test", scope, entry, "Page.md", contentHash("content"));
      cache.close();

      writeFileSync(join(repoDir, "Page.md"), injectFrontmatter("content", { id: "p1" }), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      // Remote returns same version
      const provider = makeProvider({
        list: async function* () {
          yield makeEntry({ id: "p1", title: "Page", version: 1 });
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.committed).toBe(false);
    });

    test("fetches content individually when not inline", async () => {
      const { cache } = setupRepo(repoDir);
      cache.close();

      // Entry without inline content
      const entry = makeEntry({ id: "p1", title: "Page" });
      let fetchCalled = false;

      const provider = makeProvider({
        list: async function* () {
          yield entry;
        },
        fetch: async (_scope, id) => {
          fetchCalled = true;
          return { content: "fetched content", entry: makeEntry({ id }) };
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(fetchCalled).toBe(true);
      expect(result.created).toBe(1);
      const content = readFileSync(join(repoDir, "Page.md"), "utf-8");
      expect(content).toContain("fetched content");
    });
  });

  describe("incremental sync", () => {
    test("uses changes() when available and lastSynced exists", async () => {
      const { cache, scope } = setupRepo(repoDir);
      // Ensure lastSynced is set (saveScopeMeta sets it)
      cache.close();

      let changesCalled = false;
      const changes: ChangeEvent[] = [
        { entry: makeEntry({ id: "p1", title: "New Page", version: 1, content: "hello" }), type: "created" },
      ];

      const provider = makeProvider({
        changes: async function* () {
          changesCalled = true;
          for (const c of changes) yield c;
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(changesCalled).toBe(true);
      expect(result.incremental).toBe(true);
      expect(result.created).toBe(1);
    });

    test("--full flag forces full sync even when incremental is available", async () => {
      const { cache } = setupRepo(repoDir);
      cache.close();

      let changesCalled = false;
      let listCalled = false;

      const provider = makeProvider({
        changes: async function* (_scope, _since) {
          changesCalled = true;
          yield* [] as ChangeEvent[];
        },
        list: async function* () {
          listCalled = true;
          yield* [] as RemoteEntry[];
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {}, full: true });

      expect(changesCalled).toBe(false);
      expect(listCalled).toBe(true);
      expect(result.incremental).toBe(false);
    });

    test("handles updated entries in incremental sync", async () => {
      const { cache, scope } = setupRepo(repoDir);
      const oldEntry = makeEntry({ id: "p1", title: "Page", version: 1 });
      cache.upsert("test", scope, oldEntry, "Page.md", contentHash("old"));
      cache.close();

      writeFileSync(join(repoDir, "Page.md"), injectFrontmatter("old", { id: "p1" }), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      const updatedEntry = makeEntry({ id: "p1", title: "Page", version: 2, content: "updated" });
      const provider = makeProvider({
        changes: async function* () {
          yield { entry: updatedEntry, type: "updated" } as ChangeEvent;
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.updated).toBe(1);
      expect(result.incremental).toBe(true);
      const content = readFileSync(join(repoDir, "Page.md"), "utf-8");
      expect(content).toContain("updated");
    });

    test("handles deleted entries in incremental sync", async () => {
      const { cache, scope } = setupRepo(repoDir);
      cache.upsert("test", scope, makeEntry({ id: "p1", title: "Gone" }), "Gone.md", contentHash("content"));
      cache.close();

      writeFileSync(join(repoDir, "Gone.md"), injectFrontmatter("content", { id: "p1" }), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      const provider = makeProvider({
        changes: async function* () {
          yield { entry: makeEntry({ id: "p1" }), type: "deleted" } as ChangeEvent;
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.deleted).toBe(1);
      expect(result.incremental).toBe(true);
      expect(existsSync(join(repoDir, "Gone.md"))).toBe(false);
    });

    test("falls back to full sync on TruncatedChangesError", async () => {
      const { cache } = setupRepo(repoDir);
      cache.close();

      let listCalled = false;
      const provider = makeProvider({
        changes: (_scope, _since) => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new TruncatedChangesError(500, 250)),
          }),
        }),
        list: async function* () {
          listCalled = true;
          yield makeEntry({ id: "p1", title: "Page", version: 1, content: "full sync content" });
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(listCalled).toBe(true);
      expect(result.incremental).toBe(false);
      expect(result.created).toBe(1);
    });

    test("fetches content for entries without inline content", async () => {
      const { cache } = setupRepo(repoDir);
      cache.close();

      let fetchCalled = false;
      const provider = makeProvider({
        changes: async function* () {
          yield { entry: makeEntry({ id: "p1", title: "Page", version: 1 }), type: "created" } as ChangeEvent;
        },
        fetch: async (_scope, id) => {
          fetchCalled = true;
          return { content: "fetched via fetch()", entry: makeEntry({ id }) };
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(fetchCalled).toBe(true);
      expect(result.created).toBe(1);
    });

    test("detects renames (same id, different path) in incremental sync", async () => {
      const { cache, scope } = setupRepo(repoDir);
      cache.upsert("test", scope, makeEntry({ id: "p1", title: "Old Title" }), "Old Title.md", contentHash("content"));
      cache.close();

      writeFileSync(join(repoDir, "Old Title.md"), injectFrontmatter("content", { id: "p1" }), "utf-8");
      execSync("git add -A && git commit -m 'existing'", { cwd: repoDir, stdio: "pipe", env: cleanGitEnv(repoDir) });

      // Entry with new title (different path)
      const renamedEntry = makeEntry({ id: "p1", title: "New Title", version: 2, content: "content" });
      const provider = makeProvider({
        changes: async function* () {
          yield { entry: renamedEntry, type: "updated" } as ChangeEvent;
        },
        toPath: (entry) => `${entry.title}.md`,
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(result.updated).toBe(1);
      // Old file should be gone, new file should exist
      expect(existsSync(join(repoDir, "Old Title.md"))).toBe(false);
      expect(existsSync(join(repoDir, "New Title.md"))).toBe(true);
    });
  });

  describe("error handling", () => {
    test("throws when no cache exists", async () => {
      const provider = makeProvider();
      await expect(pull({ repoDir, provider })).rejects.toThrow("No cache found");
    });

    test("throws when no scope in cache", async () => {
      mkdirSync(join(repoDir, ".clone"), { recursive: true });
      const cache = new CloneCache(join(repoDir, ".clone", "cache.sqlite"));
      cache.close();

      const provider = makeProvider();
      await expect(pull({ repoDir, provider, onProgress: () => {} })).rejects.toThrow("No scope found");
    });

    test("falls back to full sync when provider has no changes()", async () => {
      const { cache } = setupRepo(repoDir);
      cache.close();

      let listCalled = false;
      const provider = makeProvider({
        changes: undefined,
        list: async function* () {
          listCalled = true;
          yield* [] as RemoteEntry[];
        },
      });

      const result = await pull({ repoDir, provider, onProgress: () => {} });

      expect(listCalled).toBe(true);
      expect(result.incremental).toBe(false);
    });
  });
});
