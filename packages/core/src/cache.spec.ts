import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAliasCache, pruneExpiredCache } from "./cache";
import { _restoreOptions, options } from "./constants";

function tmpDir(): string {
  const dir = join(tmpdir(), `mcp-cli-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("createAliasCache", () => {
  let origCacheDir: string;

  beforeEach(() => {
    origCacheDir = options.CACHE_DIR;
    options.CACHE_DIR = tmpDir();
  });

  afterEach(() => {
    options.CACHE_DIR = origCacheDir;
  });

  test("cache miss calls producer and returns value", async () => {
    const cache = createAliasCache("test-alias");
    const producer = mock(() => ({ data: 42 }));

    const result = await cache("my-key", producer);

    expect(result).toEqual({ data: 42 });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  test("cache hit returns cached value without calling producer", async () => {
    const cache = createAliasCache("test-alias");
    const producer = mock(() => ({ data: 42 }));

    await cache("my-key", producer);
    const result = await cache("my-key", producer);

    expect(result).toEqual({ data: 42 });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  test("expired entry calls producer again", async () => {
    const cache = createAliasCache("test-alias");
    let callCount = 0;
    const producer = () => ({ call: ++callCount });

    // Write with TTL of 1ms
    const result1 = await cache("expiry-key", producer, { ttl: 1 });
    expect(result1).toEqual({ call: 1 });

    // Wait for expiry
    await Bun.sleep(5);

    const result2 = await cache("expiry-key", producer, { ttl: 1 });
    expect(result2).toEqual({ call: 2 });
  });

  test("uses custom prefix for cache namespace", async () => {
    const cache = createAliasCache("default-name");
    await cache("k", () => "val", { prefix: "custom-prefix" });

    const cacheDir = join(options.CACHE_DIR, "alias", "custom-prefix");
    expect(existsSync(join(cacheDir, "k.json"))).toBe(true);
  });

  test("sanitizes key for filename safety", async () => {
    const cache = createAliasCache("test-alias");
    await cache("board/123:sprint", () => "val");

    const cacheDir = join(options.CACHE_DIR, "alias", "test-alias");
    expect(existsSync(join(cacheDir, "board_123_sprint.json"))).toBe(true);
  });

  test("handles async producer", async () => {
    const cache = createAliasCache("test-alias");
    const result = await cache("async-key", async () => {
      await Bun.sleep(1);
      return "async-value";
    });
    expect(result).toBe("async-value");
  });

  test("handles corrupt cache file gracefully", async () => {
    const cache = createAliasCache("test-alias");
    const cacheDir = join(options.CACHE_DIR, "alias", "test-alias");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "corrupt-key.json"), "not-json{{{");

    const result = await cache("corrupt-key", () => "fresh-value");
    expect(result).toBe("fresh-value");
  });
});

describe("pruneExpiredCache", () => {
  let origCacheDir: string;

  beforeEach(() => {
    origCacheDir = options.CACHE_DIR;
    options.CACHE_DIR = tmpDir();
  });

  afterEach(() => {
    options.CACHE_DIR = origCacheDir;
  });

  test("returns 0 when cache dir does not exist", () => {
    // Point to non-existent dir
    options.CACHE_DIR = join(tmpdir(), `nonexistent-${Math.random().toString(36).slice(2)}`);
    expect(pruneExpiredCache()).toBe(0);
  });

  test("prunes expired entries", () => {
    const dir = join(options.CACHE_DIR, "alias", "my-alias");
    mkdirSync(dir, { recursive: true });

    // Expired entry
    writeFileSync(join(dir, "old.json"), JSON.stringify({ value: "stale", expiresAt: Date.now() - 1000 }));

    // Fresh entry
    writeFileSync(join(dir, "fresh.json"), JSON.stringify({ value: "good", expiresAt: Date.now() + 60_000 }));

    const pruned = pruneExpiredCache();
    expect(pruned).toBe(1);

    // Fresh entry should remain
    expect(existsSync(join(dir, "fresh.json"))).toBe(true);
    expect(existsSync(join(dir, "old.json"))).toBe(false);
  });

  test("removes corrupt entries", () => {
    const dir = join(options.CACHE_DIR, "alias", "corrupt-alias");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not valid json");

    const pruned = pruneExpiredCache();
    expect(pruned).toBe(1);
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
  });

  test("removes empty prefix directories", () => {
    const dir = join(options.CACHE_DIR, "alias", "empty-prefix");
    mkdirSync(dir, { recursive: true });

    // Only expired entry — will be pruned, leaving empty dir
    writeFileSync(join(dir, "old.json"), JSON.stringify({ value: "x", expiresAt: Date.now() - 1 }));

    pruneExpiredCache();
    expect(existsSync(dir)).toBe(false);
  });

  test("handles multiple prefixes", () => {
    const dir1 = join(options.CACHE_DIR, "alias", "alias-a");
    const dir2 = join(options.CACHE_DIR, "alias", "alias-b");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    writeFileSync(join(dir1, "e1.json"), JSON.stringify({ value: 1, expiresAt: Date.now() - 1 }));
    writeFileSync(join(dir2, "e2.json"), JSON.stringify({ value: 2, expiresAt: Date.now() - 1 }));
    writeFileSync(join(dir2, "e3.json"), JSON.stringify({ value: 3, expiresAt: Date.now() + 60_000 }));

    const pruned = pruneExpiredCache();
    expect(pruned).toBe(2);

    // alias-a should be removed (empty), alias-b should remain (has fresh entry)
    expect(existsSync(dir1)).toBe(false);
    expect(existsSync(dir2)).toBe(true);
  });
});
