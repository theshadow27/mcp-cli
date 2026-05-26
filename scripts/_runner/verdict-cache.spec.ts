import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeVerdictKey, lookupVerdict, storeVerdict } from "./verdict-cache";

function makeTmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "verdict-cache-test-"));
}

describe("verdict-cache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp(): string {
    const d = makeTmpRepo();
    dirs.push(d);
    return d;
  }

  it("returns null for a cache miss", () => {
    const root = tmp();
    expect(lookupVerdict(root, "abc:def:123")).toBeNull();
  });

  it("stores and retrieves a passing verdict", () => {
    const root = tmp();
    storeVerdict(root, "key1", true);
    expect(lookupVerdict(root, "key1")).toBe(true);
  });

  it("stores and retrieves a failing verdict", () => {
    const root = tmp();
    storeVerdict(root, "key1", false);
    expect(lookupVerdict(root, "key1")).toBe(false);
  });

  it("overwrites an existing entry for the same key", () => {
    const root = tmp();
    storeVerdict(root, "key1", false);
    storeVerdict(root, "key1", true);
    expect(lookupVerdict(root, "key1")).toBe(true);
    const raw = JSON.parse(readFileSync(join(root, "build/.verdict-cache.json"), "utf8"));
    expect(raw.entries.filter((e: { key: string }) => e.key === "key1")).toHaveLength(1);
  });

  it("evicts old entries beyond MAX_ENTRIES (16)", () => {
    const root = tmp();
    for (let i = 0; i < 20; i++) {
      storeVerdict(root, `key-${i}`, true);
    }
    const raw = JSON.parse(readFileSync(join(root, "build/.verdict-cache.json"), "utf8"));
    expect(raw.entries).toHaveLength(16);
    expect(lookupVerdict(root, "key-0")).toBeNull();
    expect(lookupVerdict(root, "key-19")).toBe(true);
  });

  it("creates build/ directory if missing", () => {
    const root = tmp();
    expect(existsSync(join(root, "build"))).toBe(false);
    storeVerdict(root, "k", true);
    expect(existsSync(join(root, "build/.verdict-cache.json"))).toBe(true);
  });

  it("handles corrupt cache file gracefully", () => {
    const root = tmp();
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build/.verdict-cache.json"), "NOT JSON");
    expect(lookupVerdict(root, "anything")).toBeNull();
    storeVerdict(root, "after-corrupt", true);
    expect(lookupVerdict(root, "after-corrupt")).toBe(true);
  });

  it("handles valid JSON with wrong shape gracefully", () => {
    const root = tmp();
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build/.verdict-cache.json"), '{"entries": "not an array"}');
    expect(lookupVerdict(root, "anything")).toBeNull();
    storeVerdict(root, "after-bad-shape", true);
    expect(lookupVerdict(root, "after-bad-shape")).toBe(true);
  });
});

describe("computeVerdictKey", () => {
  it("returns a non-null string when git commands succeed", () => {
    const key = computeVerdictKey(() => "abc123");
    expect(key).not.toBeNull();
    expect(typeof key).toBe("string");
    // Format: <base>:<headSha>:<diffHash>
    expect(key).toMatch(/^[^:]+:[a-f0-9]+:[a-f0-9]+$/);
  });

  it("includes the resolveBase return value as the first segment", () => {
    const key = computeVerdictKey(() => "mybase-sha");
    expect(key?.startsWith("mybase-sha:")).toBe(true);
  });

  it("returns null when resolveBase throws", () => {
    expect(() =>
      computeVerdictKey(() => {
        throw new Error("no base");
      }),
    ).toThrow("no base");
  });

  it("produces different keys for different bases", () => {
    const key1 = computeVerdictKey(() => "base-a");
    const key2 = computeVerdictKey(() => "base-b");
    expect(key1).not.toBe(key2);
  });
});
