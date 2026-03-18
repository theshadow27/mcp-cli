import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TimingCache,
  type TimingCacheFile,
  findChangedFiles,
  hashFileContent,
  loadTimings,
  pruneStaleEntries,
  saveTimings,
} from "./test-timings";

describe("hashFileContent", () => {
  it("returns a hex string", () => {
    const hash = hashFileContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns the same hash for the same content", () => {
    expect(hashFileContent("abc")).toBe(hashFileContent("abc"));
  });

  it("returns different hashes for different content", () => {
    expect(hashFileContent("abc")).not.toBe(hashFileContent("xyz"));
  });
});

describe("loadTimings / saveTimings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "test-timings-"));
  });

  it("returns empty object when file does not exist", () => {
    expect(loadTimings(join(dir, "missing.json"))).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json");
    expect(loadTimings(path)).toEqual({});
  });

  it("returns empty object for non-object JSON", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, "[1,2,3]");
    expect(loadTimings(path)).toEqual({});
  });

  it("round-trips cache data", () => {
    const path = join(dir, "cache.json");
    const cache: TimingCache = {
      "b.spec.ts": { hash: "bbb", timeMs: 200 },
      "a.spec.ts": { hash: "aaa", timeMs: 100 },
    };
    saveTimings(path, cache);
    const loaded = loadTimings(path);
    expect(loaded).toEqual(cache);
  });

  it("saves keys in sorted order", async () => {
    const path = join(dir, "sorted.json");
    saveTimings(path, {
      "z.spec.ts": { hash: "z", timeMs: 1 },
      "a.spec.ts": { hash: "a", timeMs: 2 },
    });
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as TimingCacheFile;
    const keys = Object.keys(parsed.entries);
    expect(keys).toEqual(["a.spec.ts", "z.spec.ts"]);
  });

  it("includes bunVersion in saved JSON", async () => {
    const path = join(dir, "versioned.json");
    saveTimings(path, { "a.spec.ts": { hash: "aaa", timeMs: 100 } });
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as TimingCacheFile;
    expect(parsed.bunVersion).toBe(Bun.version);
    expect(parsed.entries).toBeDefined();
  });

  it("discards cache when bunVersion mismatches", () => {
    const path = join(dir, "stale.json");
    const data: TimingCacheFile = {
      bunVersion: "0.0.0-fake",
      entries: { "a.spec.ts": { hash: "aaa", timeMs: 100 } },
    };
    writeFileSync(path, JSON.stringify(data));
    expect(loadTimings(path)).toEqual({});
  });

  it("discards legacy flat-map format", () => {
    const path = join(dir, "legacy.json");
    // Old format: no bunVersion wrapper
    writeFileSync(path, JSON.stringify({ "a.spec.ts": { hash: "aaa", timeMs: 100 } }));
    expect(loadTimings(path)).toEqual({});
  });

  it("atomic write does not leave temp files on success", () => {
    const path = join(dir, "atomic.json");
    saveTimings(path, { "a.spec.ts": { hash: "aaa", timeMs: 100 } });
    expect(existsSync(path)).toBe(true);
    // Temp file should have been renamed away
    const tmpPath = join(dir, `.test-timings.${process.pid}.tmp`);
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe("findChangedFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "test-timings-changed-"));
  });

  it("marks all files as changed when cache is empty", async () => {
    const fileA = join(dir, "a.spec.ts");
    const fileB = join(dir, "b.spec.ts");
    writeFileSync(fileA, "test a");
    writeFileSync(fileB, "test b");

    const { changed } = await findChangedFiles([fileA, fileB], {});
    expect(changed).toEqual([fileA, fileB]);
  });

  it("skips files whose hash matches the cache", async () => {
    const fileA = join(dir, "a.spec.ts");
    writeFileSync(fileA, "test content");

    // First pass to get the hash
    const { hashes } = await findChangedFiles([fileA], {});
    const cache: TimingCache = {
      [fileA]: { hash: hashes[fileA], timeMs: 100 },
    };

    // Second pass — no changes
    const { changed } = await findChangedFiles([fileA], cache);
    expect(changed).toEqual([]);
  });

  it("detects changed files", async () => {
    const fileA = join(dir, "a.spec.ts");
    writeFileSync(fileA, "original");

    const { hashes } = await findChangedFiles([fileA], {});
    const cache: TimingCache = {
      [fileA]: { hash: hashes[fileA], timeMs: 100 },
    };

    // Modify the file
    writeFileSync(fileA, "modified");
    const { changed } = await findChangedFiles([fileA], cache);
    expect(changed).toEqual([fileA]);
  });
});

describe("pruneStaleEntries", () => {
  it("removes entries not in the current file set", () => {
    const cache: TimingCache = {
      "a.spec.ts": { hash: "aaa", timeMs: 100 },
      "b.spec.ts": { hash: "bbb", timeMs: 200 },
      "c.spec.ts": { hash: "ccc", timeMs: 300 },
    };
    const current = new Set(["a.spec.ts", "c.spec.ts"]);
    const removed = pruneStaleEntries(cache, current);
    expect(removed).toBe(1);
    expect(cache).toEqual({
      "a.spec.ts": { hash: "aaa", timeMs: 100 },
      "c.spec.ts": { hash: "ccc", timeMs: 300 },
    });
  });

  it("returns 0 when nothing to prune", () => {
    const cache: TimingCache = {
      "a.spec.ts": { hash: "aaa", timeMs: 100 },
    };
    expect(pruneStaleEntries(cache, new Set(["a.spec.ts"]))).toBe(0);
  });

  it("handles empty cache", () => {
    const cache: TimingCache = {};
    expect(pruneStaleEntries(cache, new Set(["a.spec.ts"]))).toBe(0);
  });
});
