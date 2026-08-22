import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VFS_COMPLETED, VFS_FAILED, VFS_PROGRESS, VFS_STARTED } from "@mcp-cli/core";
import type { RemoteEntry, RemoteProvider, ResolvedScope, Scope } from "../providers/provider";
import { CloneCache } from "./cache";
import { clone, computeDepth } from "./clone";
import { stripFrontmatter } from "./frontmatter";
import type { VfsProgressEvent } from "./progress";

const TMP = join(tmpdir(), `clone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Build env without GIT_* vars so git commands target the test repo, not the parent. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  env.GIT_CEILING_DIRECTORIES = TMP;
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

describe("computeDepth", () => {
  function entry(id: string, parentId?: string): RemoteEntry {
    return { id, title: `Page ${id}`, parentId, version: 1, lastModified: "2026-01-01T00:00:00Z", metadata: {} };
  }

  test("root page (no parent) has depth 1", () => {
    const entries = [entry("r1")];
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(computeDepth(entries[0], byId)).toBe(1);
  });

  test("child of root has depth 2", () => {
    const entries = [entry("r1"), entry("c1", "r1")];
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(computeDepth(entries[1], byId)).toBe(2);
  });

  test("grandchild has depth 3", () => {
    const entries = [entry("r1"), entry("c1", "r1"), entry("gc1", "c1")];
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(computeDepth(entries[2], byId)).toBe(3);
  });

  test("parent not in entries set counts as root", () => {
    const entries = [entry("orphan", "missing-parent")];
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(computeDepth(entries[0], byId)).toBe(1);
  });

  test("cycle does not cause infinite loop", () => {
    const e1 = entry("a", "b");
    const e2 = entry("b", "a");
    const byId = new Map([
      [e1.id, e1],
      [e2.id, e2],
    ]);
    const depth = computeDepth(e1, byId);
    expect(depth).toBeGreaterThanOrEqual(1);
    expect(depth).toBeLessThanOrEqual(3);
  });
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

  test("throws when git init does not create .git", async () => {
    const provider = makeProvider();
    const scope = makeScope();

    await expect(clone({ targetDir, provider, scope, onProgress: () => {}, _gitInit: () => {} })).rejects.toThrow(
      'git init did not create .git at "',
    );
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

  test("sets mcx:// remote and upstream tracking on main", async () => {
    const provider = makeProvider({
      list: async function* () {
        yield makeEntry({ id: "p1", title: "Page One", version: 1, content: "body" });
      },
    });

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {} });

    const remotes = execSync("git remote -v", { cwd: targetDir, encoding: "utf-8", env: cleanEnv() });
    expect(remotes).toContain("origin\tmcx://test/FOO (fetch)");
    expect(remotes).toContain("origin\tmcx://test/FOO (push)");

    const branchRemote = execSync("git config branch.main.remote", {
      cwd: targetDir,
      encoding: "utf-8",
      env: cleanEnv(),
    }).trim();
    expect(branchRemote).toBe("origin");

    const branchMerge = execSync("git config branch.main.merge", {
      cwd: targetDir,
      encoding: "utf-8",
      env: cleanEnv(),
    }).trim();
    expect(branchMerge).toBe("refs/heads/main");
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

describe("clone progress reporting (#1249)", () => {
  /** Provider over `count` pages that names what it counts. */
  function bulkProvider(count: number, overrides: Partial<RemoteProvider> = {}): RemoteProvider {
    const entries = Array.from({ length: count }, (_, i) =>
      makeEntry({ id: `p${i}`, title: `Page ${i}`, version: 1, content: `Body ${i}` }),
    );
    return makeProvider({
      itemNoun: "pages",
      list: async function* () {
        for (const e of entries) yield e;
      },
      ...overrides,
    });
  }

  function sink(events: VfsProgressEvent[]): (e: VfsProgressEvent) => void {
    return (e) => {
      events.push(e);
    };
  }

  test("emits started, progress and exactly one terminal event", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(40, { count: async () => 40 });

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) });

    expect(events[0]).toMatchObject({ event: VFS_STARTED, operation: "clone", provider: "test", scope: "FOO" });
    // The denominator resolves *after* started, so a rate-limited count() can no
    // longer delay the first sign of life by minutes.
    expect(events[0].total).toBeUndefined();

    const listing = events.filter((e) => e.event === VFS_PROGRESS && e.phase === "list");
    expect(listing.map((e) => e.current)).toEqual([10, 20, 30, 40]); // 5% of 40, floored at 10
    expect(listing[0]).toMatchObject({ current: 10, total: 40, percent: 25 });

    const terminal = events.filter((e) => e.event === VFS_COMPLETED || e.event === VFS_FAILED);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ event: VFS_COMPLETED, current: 40, total: 40, percent: 100, items: 40 });
  });

  test("carries repoRoot and a single runId so monitors filter and demultiplex", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(40, { count: async () => 40 });

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) });

    // Without repoRoot every event passes every repo-scoped monitor filter
    // (event-filter.ts) — a clone elsewhere on the box would spray into an
    // unrelated repo's stream.
    expect(new Set(events.map((e) => e.repoRoot))).toEqual(new Set([resolve(targetDir)]));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
    expect(events[0].runId).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(events.map((e) => e.unit))).toEqual(new Set(["pages"]));
  });

  test("publishes a terminal vfs.failed when the remote throws mid-listing", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(40, {
      count: async () => 40,
      list: async function* () {
        yield makeEntry({ id: "p0", title: "Page 0", content: "Body 0" });
        throw new Error("401 token expired");
      },
    });

    await expect(
      clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) }),
    ).rejects.toThrow("401 token expired");

    // The invariant subscribers depend on: started is never left dangling, so
    // `mcx monitor --until` and ctx.waitForEvent terminate on failure too.
    expect(events[0].event).toBe(VFS_STARTED);
    expect(events.at(-1)).toMatchObject({ event: VFS_FAILED, error: "401 token expired", runId: events[0].runId });
    expect(events.filter((e) => e.event === VFS_FAILED || e.event === VFS_COMPLETED)).toHaveLength(1);
  });

  test("a failure before the operation starts emits nothing at all", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(5, {
      resolveScope: async () => {
        throw new Error("space not found");
      },
    });

    await expect(
      clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) }),
    ).rejects.toThrow("space not found");
    expect(events).toEqual([]);
  });

  test("renders the count and percent on the stderr line", async () => {
    const lines: string[] = [];
    const provider = bulkProvider(40, { count: async () => 40 });

    await clone({
      targetDir,
      provider,
      scope: makeScope("FOO"),
      onProgress: (m) => {
        lines.push(m);
      },
    });

    expect(lines).toContain("Cloning test/FOO...");
    expect(lines).toContain("  → 40 pages to fetch");
    expect(lines).toContain("  Fetching FOO... 10/40 pages (25%)");
    expect(lines).toContain("  Fetching FOO... 40/40 pages (100%)");
  });

  test("falls back to a bare counter when the provider cannot count", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(60);

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) });

    const listing = events.filter((e) => e.event === VFS_PROGRESS && e.phase === "list");
    expect(listing.map((e) => e.current)).toEqual([50]); // default 50-item step
    expect(listing[0].total).toBeUndefined();
    expect(listing[0].percent).toBeUndefined();
  });

  test("a failing count() does not fail the clone", async () => {
    const provider = bulkProvider(10, {
      count: async () => {
        throw new Error("CQL search unavailable");
      },
    });

    const result = await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {} });
    expect(result.pageCount).toBe(10);
  });

  test("--limit caps the reported total, so progress cannot exceed 100%", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(40, { count: async () => 40 });

    await clone({
      targetDir,
      provider,
      scope: makeScope("FOO"),
      limit: 10,
      onProgress: () => {},
      onEvent: sink(events),
    });

    const listing = events.filter((e) => e.event === VFS_PROGRESS && e.phase === "list");
    expect(listing.at(-1)).toMatchObject({ current: 10, total: 10, percent: 100 });
  });

  test("reports the content phase when the listing carried no inline content", async () => {
    const events: VfsProgressEvent[] = [];
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry({ id: `p${i}`, title: `Page ${i}` }));
    const provider = makeProvider({
      itemNoun: "pages",
      count: async () => 20,
      list: async function* () {
        for (const e of entries) yield e; // no `content` — forces individual fetches
      },
    });

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) });

    const content = events.filter((e) => e.event === VFS_PROGRESS && e.phase === "content");
    expect(content.at(-1)).toMatchObject({ current: 20, total: 20, percent: 100 });
  });

  test("writing files is not a reported phase — it is local and fast", async () => {
    const events: VfsProgressEvent[] = [];
    const provider = bulkProvider(40, { count: async () => 40 });

    await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {}, onEvent: sink(events) });

    expect(events.some((e) => e.phase !== undefined && e.phase !== "list" && e.phase !== "content")).toBe(false);
  });

  test("clone works with no event sink attached", async () => {
    const provider = bulkProvider(5, { count: async () => 5 });
    const result = await clone({ targetDir, provider, scope: makeScope("FOO"), onProgress: () => {} });
    expect(result.pageCount).toBe(5);
  });
});

describe("clone with --depth", () => {
  const DEPTH_TMP = join(tmpdir(), `clone-depth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function entry(id: string, title: string, parentId?: string, content?: string): RemoteEntry {
    return {
      id,
      title,
      parentId,
      version: 1,
      lastModified: "2026-01-01T00:00:00Z",
      metadata: {},
      ...(content != null ? { content } : {}),
    };
  }

  function makeDepthProvider(entries: RemoteEntry[]): RemoteProvider {
    return {
      name: "test",
      resolveScope: async (s: Scope) => ({
        key: s.key,
        cloudId: s.cloudId ?? "cloud-1",
        resolved: { spaceId: "sp-1", spaceName: "Test Space" },
      }),
      list: async function* () {
        for (const e of entries) yield e;
      },
      fetch: async (_s, id) => {
        const e = entries.find((x) => x.id === id);
        return { content: e?.content ?? "", entry: e ?? entry(id, id) };
      },
      toPath: (e, all) => {
        // Simple path: parentTitle/childTitle.md
        const parent = e.parentId ? all.find((x) => x.id === e.parentId) : undefined;
        const hasChildren = all.some((x) => x.parentId === e.id);
        const name = e.title.replace(/[^a-zA-Z0-9-_ ]/g, "");
        if (hasChildren) {
          return parent ? `${parent.title}/${name}/_index.md` : `${name}/_index.md`;
        }
        return parent ? `${parent.title}/${name}.md` : `${name}.md`;
      },
      frontmatter: (e, s) => ({ id: e.id, version: e.version, space: s.key }),
    };
  }

  beforeEach(() => {
    mkdirSync(DEPTH_TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(DEPTH_TMP, { recursive: true, force: true });
  });

  test("depth 1 clones only root pages, stubs the rest", async () => {
    const entries = [
      entry("r1", "Root", undefined, "# Root content"),
      entry("c1", "Child", "r1", "# Child content"),
      entry("gc1", "Grandchild", "c1", "# Grandchild content"),
    ];

    const depthTargetDir = join(DEPTH_TMP, "depth1");
    const result = await clone({
      targetDir: depthTargetDir,
      provider: makeDepthProvider(entries),
      scope: { key: "TEST" },
      depth: 1,
      onProgress: () => {},
    });

    expect(result.pageCount).toBe(1);
    expect(result.stubCount).toBe(2);

    // Root should have full content
    const rootFile = readFileSync(join(depthTargetDir, "Root/_index.md"), "utf-8");
    const { content: rootContent } = stripFrontmatter(rootFile);
    expect(rootContent).toBe("# Root content");

    // Child should be a stub (has children, so it's _index.md)
    const childFile = readFileSync(join(depthTargetDir, "Root/Child/_index.md"), "utf-8");
    const { content: childContent, fields: childFields } = stripFrontmatter(childFile);
    expect(childContent).toContain("Shallow clone stub");
    expect(childFields?.stub).toBe(true);
  });

  test("depth 2 includes root + children, stubs grandchildren", async () => {
    const entries = [
      entry("r1", "Root", undefined, "# Root"),
      entry("c1", "Child", "r1", "# Child"),
      entry("gc1", "Grandchild", "c1", "# Grandchild"),
    ];

    const depthTargetDir = join(DEPTH_TMP, "depth2");
    const result = await clone({
      targetDir: depthTargetDir,
      provider: makeDepthProvider(entries),
      scope: { key: "TEST" },
      depth: 2,
      onProgress: () => {},
    });

    expect(result.pageCount).toBe(2);
    expect(result.stubCount).toBe(1);
  });

  test("depth 0 (unlimited) clones everything", async () => {
    const entries = [
      entry("r1", "Root", undefined, "# Root"),
      entry("c1", "Child", "r1", "# Child"),
      entry("gc1", "Grandchild", "c1", "# Grandchild"),
    ];

    const depthTargetDir = join(DEPTH_TMP, "depth0");
    const result = await clone({
      targetDir: depthTargetDir,
      provider: makeDepthProvider(entries),
      scope: { key: "TEST" },
      depth: 0,
      onProgress: () => {},
    });

    expect(result.pageCount).toBe(3);
    expect(result.stubCount).toBe(0);
  });

  test("stores depth in scope meta", async () => {
    const entries = [entry("r1", "Root", undefined, "# Root")];
    const depthTargetDir = join(DEPTH_TMP, "meta");

    const result = await clone({
      targetDir: depthTargetDir,
      provider: makeDepthProvider(entries),
      scope: { key: "TEST" },
      depth: 2,
      onProgress: () => {},
    });

    expect(result.scope.resolved.cloneDepth).toBe(2);
  });
});
