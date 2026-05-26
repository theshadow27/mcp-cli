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
  // Tests run inside the mcp-cli worktree — a valid git repo with a HEAD commit.
  // computeVerdictKey runs git commands in process.cwd() so there's no need to
  // create a temporary repo.

  it("returns a non-null string with three colon-separated parts in a valid git repo", () => {
    const key = computeVerdictKey(() => "HEAD~1");
    expect(key).not.toBeNull();
    const parts = (key as string).split(":");
    // Format: <base>:<headSha>:<diffHash> — three non-empty segments.
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });

  it("is stable across identical invocations (same state → same key)", () => {
    const base = "HEAD~1";
    const key1 = computeVerdictKey(() => base);
    const key2 = computeVerdictKey(() => base);
    expect(key1).toEqual(key2);
  });

  it("changes when the base ref changes", () => {
    // Two different base refs produce different keys because the first
    // key segment (the resolved base SHA) changes.
    const key1 = computeVerdictKey(() => "HEAD~1");
    const key2 = computeVerdictKey(() => "HEAD~2");
    // HEAD~2 may not exist in a shallow repo — skip gracefully.
    if (key1 === null || key2 === null) return;
    expect(key1).not.toEqual(key2);
  });
});
