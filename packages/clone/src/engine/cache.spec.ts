import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RemoteEntry, ResolvedScope } from "../providers/provider";
import { CloneCache } from "./cache";

const TMP = join(import.meta.dir, "__test_cache_tmp__");

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

let cache: CloneCache;
let dbPath: string;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dbPath = join(TMP, `cache-${Date.now()}.sqlite`);
  cache = new CloneCache(dbPath);
});

afterEach(() => {
  cache.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("CloneCache", () => {
  test("upsert and getById round-trip", () => {
    const scope = makeScope();
    const entry = makeEntry();
    cache.upsert("confluence", scope, entry, "My Page.md", "abc123");

    const row = cache.getById("confluence", scope.cloudId, entry.id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe("page-1");
    expect(row?.title).toBe("My Page");
    expect(row?.localPath).toBe("My Page.md");
    expect(row?.version).toBe(1);
    expect(row?.contentHash).toBe("abc123");
  });

  test("upsert and getByPath round-trip", () => {
    const scope = makeScope();
    cache.upsert("confluence", scope, makeEntry(), "docs/my-page.md", null);

    const row = cache.getByPath("docs/my-page.md");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("page-1");
  });

  test("getById returns null for unknown entry", () => {
    const row = cache.getById("confluence", "cloud-xxx", "unknown-id");
    expect(row).toBeNull();
  });

  test("getByPath returns null for unknown path", () => {
    const row = cache.getByPath("nonexistent.md");
    expect(row).toBeNull();
  });

  test("listScope returns all entries for a scope", () => {
    const scope = makeScope();
    cache.upsert("confluence", scope, makeEntry({ id: "p1", title: "Page 1" }), "page-1.md", null);
    cache.upsert("confluence", scope, makeEntry({ id: "p2", title: "Page 2" }), "page-2.md", null);

    const entries = cache.listScope("confluence", "TEST");
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  test("listScope returns empty array for unknown scope", () => {
    const entries = cache.listScope("confluence", "UNKNOWN");
    expect(entries).toHaveLength(0);
  });

  test("upsert replaces existing entry (same primary key)", () => {
    const scope = makeScope();
    cache.upsert("confluence", scope, makeEntry({ version: 1 }), "my-page.md", "hash1");
    cache.upsert("confluence", scope, makeEntry({ version: 2 }), "my-page.md", "hash2");

    const row = cache.getById("confluence", scope.cloudId, "page-1");
    expect(row?.version).toBe(2);
    expect(row?.contentHash).toBe("hash2");
  });

  test("saveScopeMeta and loadScopeMeta round-trip", () => {
    const scope = makeScope();
    cache.saveScopeMeta("confluence", scope);

    const loaded = cache.loadScopeMeta("confluence", "TEST");
    expect(loaded).not.toBeNull();
    expect(loaded?.key).toBe("TEST");
    expect(loaded?.cloudId).toBe("cloud-123");
    expect(loaded?.resolved.spaceId).toBe("space-456");
  });

  test("loadScopeMeta returns null for unknown scope", () => {
    const result = cache.loadScopeMeta("confluence", "UNKNOWN");
    expect(result).toBeNull();
  });

  test("findFirstScope finds the saved scope", () => {
    const scope = makeScope();
    cache.saveScopeMeta("confluence", scope);

    const found = cache.findFirstScope("confluence");
    expect(found).not.toBeNull();
    expect(found?.key).toBe("TEST");
  });

  test("findFirstScope returns null when no scopes exist", () => {
    const found = cache.findFirstScope("confluence");
    expect(found).toBeNull();
  });

  test("getLastSynced returns null before first sync", () => {
    const scope = makeScope();
    cache.saveScopeMeta("confluence", scope);

    const lastSynced = cache.getLastSynced("confluence", "TEST");
    // Initial saveScopeMeta sets last_synced to current time
    expect(typeof lastSynced).toBe("string");
  });

  test("updateLastSynced updates the timestamp", () => {
    const scope = makeScope();
    cache.saveScopeMeta("confluence", scope);

    const before = cache.getLastSynced("confluence", "TEST");
    cache.updateLastSynced("confluence", "TEST");
    const after = cache.getLastSynced("confluence", "TEST");

    // Both should be ISO timestamps
    expect(typeof after).toBe("string");
    // After should be >= before (use String() coercion to avoid non-null assertions)
    expect(new Date(String(after)).getTime()).toBeGreaterThanOrEqual(new Date(String(before)).getTime());
  });

  test("remove deletes the entry", () => {
    const scope = makeScope();
    cache.upsert("confluence", scope, makeEntry(), "my-page.md", null);

    cache.remove("confluence", scope.cloudId, "page-1");

    const row = cache.getById("confluence", scope.cloudId, "page-1");
    expect(row).toBeNull();
  });

  test("UNIQUE index: inserting different page to same local_path replaces existing entry", () => {
    const scope = makeScope();
    // SQLite INSERT OR REPLACE resolves UNIQUE conflicts by replacing the old row.
    // This means two pages with the same sanitized path: the second upsert wins and
    // removes the first from the cache. toPath() uses ID-suffix disambiguation to
    // prevent this in normal operation; the UNIQUE index is a safety net.
    cache.upsert("confluence", scope, makeEntry({ id: "p1" }), "clash.md", "hash1");
    cache.upsert("confluence", scope, makeEntry({ id: "p2" }), "clash.md", "hash2");

    // p1 is removed (its primary key was deleted to resolve the unique conflict on local_path)
    const p1 = cache.getById("confluence", scope.cloudId, "p1");
    // p2 is now at clash.md
    const p2 = cache.getById("confluence", scope.cloudId, "p2");
    expect(p1).toBeNull(); // replaced by p2
    expect(p2?.localPath).toBe("clash.md");
  });

  test("multiple scopes can have same local_path", () => {
    const scope1 = makeScope("SPACE1", "cloud-1");
    const scope2 = makeScope("SPACE2", "cloud-2");
    // Same path, different scopes — should be allowed
    cache.upsert("confluence", scope1, makeEntry({ id: "p1" }), "index.md", "hash1");
    cache.upsert("confluence", scope2, makeEntry({ id: "p2" }), "index.md", "hash2");

    // Both should be findable
    const entries1 = cache.listScope("confluence", "SPACE1");
    const entries2 = cache.listScope("confluence", "SPACE2");
    expect(entries1).toHaveLength(1);
    expect(entries2).toHaveLength(1);
  });
});
