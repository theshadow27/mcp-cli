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
  it("returns a key with base:head:diffHash format when run in a git repo", () => {
    const key = computeVerdictKey(() => "fakebase123");
    expect(key).not.toBeNull();
    const parts = key?.split(":");
    expect(parts).toHaveLength(3);
    expect(parts?.[0]).toBe("fakebase123");
    expect(parts?.[1]).toMatch(/^[0-9a-f]{40}$/);
    expect(parts?.[2]).toBeTruthy();
  });

  it("produces different keys for different bases", () => {
    const key1 = computeVerdictKey(() => "base-a");
    const key2 = computeVerdictKey(() => "base-b");

    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).not.toBe(key2);
  });

  it("uses the resolveBase callback for the first key component", () => {
    const key = computeVerdictKey(() => "custom-merge-base-sha");
    expect(key).not.toBeNull();
    expect(key?.startsWith("custom-merge-base-sha:")).toBe(true);
  });

  it("same inputs produce the same key (deterministic)", () => {
    const key1 = computeVerdictKey(() => "stable");
    const key2 = computeVerdictKey(() => "stable");
    expect(key1).toBe(key2);
  });
});
