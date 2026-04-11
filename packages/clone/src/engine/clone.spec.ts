import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteEntry, RemoteProvider, ResolvedScope, Scope } from "../providers/provider";
import { CloneCache } from "./cache";
import { clone } from "./clone";
import { stripFrontmatter } from "./frontmatter";

const TMP = join(tmpdir(), `clone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Build env without GIT_* vars so git commands target the test repo, not the parent. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return env;
}

function makeScope(key = "TEST", cloudId = "cloud-123"): Scope {
  return { key, cloudId };
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
    resolveScope: async (s) => ({
      ...s,
      cloudId: s.cloudId ?? "cloud-123",
      resolved: { spaceId: "space-456", spaceName: "Test Space" },
    }),
    list: async function* () {},
    fetch: async (_s, id) => ({ content: `Content of ${id}`, entry: makeEntry({ id }) }),
    toPath: (entry) => `${entry.title.replace(/[^a-zA-Z0-9-_ ]/g, "")}.md`,
    frontmatter: (entry, scope) => ({ id: entry.id, version: entry.version, space: scope.key }),
    ...overrides,
  };
}

let targetDir: string;

beforeEach(() => {
  targetDir = join(TMP, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("clone", () => {
  test("throws when target is already a git repo", async () => {
    mkdirSync(join(targetDir, ".git"), { recursive: true });
    const provider = makeProvider();
    const scope = makeScope();

    await expect(clone({ targetDir, provider, scope })).rejects.toThrow("already exists and is a git repo");
  });

  test("throws on interrupted clone (cache exists, no .git)", async () => {
    mkdirSync(join(targetDir, ".clone"), { recursive: true });
    writeFileSync(join(targetDir, ".clone", "cache.sqlite"), "");
    const provider = makeProvider();
    const scope = makeScope();

    await expect(clone({ targetDir, provider, scope })).rejects.toThrow("partial clone");
  });

  test("clones pages into a new git repo with frontmatter", async () => {
    const entries = [
      makeEntry({ id: "p1", title: "Page One", version: 1, content: "# One\nBody one" }),
      makeEntry({ id: "p2", title: "Page Two", version: 2, content: "# Two\nBody two" }),
    ];
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
    });

    const result = await clone({ targetDir, provider, scope: makeScope(), onProgress: () => {} });

    expect(result.pageCount).toBe(2);
    expect(result.path).toBe(targetDir);
    expect(result.scope.cloudId).toBe("cloud-123");

    // Git repo was initialized
    expect(existsSync(join(targetDir, ".git"))).toBe(true);

    // Files exist with frontmatter
    const file1 = readFileSync(join(targetDir, "Page One.md"), "utf-8");
    const { content, fields } = stripFrontmatter(file1);
    expect(content).toBe("# One\nBody one");
    expect(fields?.id).toBe("p1");
    expect(fields?.version).toBe(1);

    // .gitignore excludes .clone/
    const gitignore = readFileSync(join(targetDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".clone/");

    // Git has an initial commit
    const log = execSync("git log --oneline", { cwd: targetDir, encoding: "utf-8", env: cleanEnv() });
    expect(log).toContain("Clone test/TEST");
    expect(log).toContain("2 pages");
  });

  test("populates cache with all entries", async () => {
    const entries = [
      makeEntry({ id: "p1", title: "Alpha", version: 1, content: "alpha body" }),
      makeEntry({ id: "p2", title: "Beta", version: 3, content: "beta body" }),
    ];
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
    });

    await clone({ targetDir, provider, scope: makeScope(), onProgress: () => {} });

    // Open cache and verify entries
    const cache = new CloneCache(join(targetDir, ".clone", "cache.sqlite"));
    try {
      const cached = cache.listScope("test", "TEST");
      expect(cached).toHaveLength(2);

      const p1 = cache.getById("test", "cloud-123", "p1");
      expect(p1).toBeTruthy();
      expect(p1?.version).toBe(1);
      expect(p1?.localPath).toBe("Alpha.md");

      const p2 = cache.getById("test", "cloud-123", "p2");
      expect(p2).toBeTruthy();
      expect(p2?.version).toBe(3);
    } finally {
      cache.close();
    }
  });

  test("fetches content in batches for entries without inline content", async () => {
    // Create 15 entries without inline content to trigger batching (batch size = 10)
    const entries = Array.from({ length: 15 }, (_, i) => makeEntry({ id: `p${i}`, title: `Page ${i}`, version: 1 }));
    const fetchedIds: string[] = [];
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
      fetch: async (_scope, id) => {
        fetchedIds.push(id);
        return { content: `Fetched ${id}`, entry: makeEntry({ id, title: `Page ${id.slice(1)}` }) };
      },
    });

    const result = await clone({ targetDir, provider, scope: makeScope(), onProgress: () => {} });

    expect(result.pageCount).toBe(15);
    // All 15 should have been fetched individually (none had inline content)
    expect(fetchedIds).toHaveLength(15);
    // Verify content was written
    const file = readFileSync(join(targetDir, "Page 0.md"), "utf-8");
    const { content } = stripFrontmatter(file);
    expect(content).toBe("Fetched p0");
  });

  test("skips fetch for entries with inline content", async () => {
    const entries = [makeEntry({ id: "p1", title: "Inline", version: 1, content: "I have inline content" })];
    const fetchedIds: string[] = [];
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
      fetch: async (_scope, id) => {
        fetchedIds.push(id);
        return { content: "should not be used", entry: makeEntry({ id }) };
      },
    });

    await clone({ targetDir, provider, scope: makeScope(), onProgress: () => {} });

    // fetch should never have been called
    expect(fetchedIds).toHaveLength(0);
    const file = readFileSync(join(targetDir, "Inline.md"), "utf-8");
    const { content } = stripFrontmatter(file);
    expect(content).toBe("I have inline content");
  });

  test("respects limit option", async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `p${i}`, title: `Page ${i}`, version: 1, content: `Body ${i}` }),
    );
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
    });

    const result = await clone({ targetDir, provider, scope: makeScope(), limit: 5, onProgress: () => {} });

    expect(result.pageCount).toBe(5);
  });

  test("clones into non-existent target directory", async () => {
    const deepTarget = join(targetDir, "a", "b", "c");
    const entries = [makeEntry({ id: "p1", title: "Deep", version: 1, content: "deep content" })];
    const provider = makeProvider({
      list: async function* () {
        for (const e of entries) yield e;
      },
    });

    const result = await clone({ targetDir: deepTarget, provider, scope: makeScope(), onProgress: () => {} });
    expect(result.pageCount).toBe(1);
    expect(existsSync(join(deepTarget, "Deep.md"))).toBe(true);
    expect(existsSync(join(deepTarget, ".git"))).toBe(true);
  });

  test("handles empty space (zero pages)", async () => {
    const provider = makeProvider({
      list: async function* () {},
    });

    const result = await clone({ targetDir, provider, scope: makeScope(), onProgress: () => {} });
    expect(result.pageCount).toBe(0);
    // Git repo still gets initialized
    expect(existsSync(join(targetDir, ".git"))).toBe(true);
  });
});
