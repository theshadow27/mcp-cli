import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVerdictKey, lookupVerdict, storeVerdict } from "./verdict-cache";

/** Strip GIT_* env vars so git operations in temp repos don't inherit GIT_DIR /
 *  GIT_INDEX_FILE from an outer `git commit` invocation (e.g. the pre-commit hook)
 *  and accidentally commit into the developer's working branch. */
function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return env;
}

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
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function initGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "verdict-key-test-"));
    dirs.push(dir);
    const gitOpts = { cwd: dir, env: cleanGitEnv() };
    spawnSync("git", ["init"], gitOpts);
    spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
      gitOpts,
    );
    return dir;
  }

  it("returns a non-null string with three colon-separated parts in a valid git repo", () => {
    const dir = initGitRepo();
    const key = computeVerdictKey(() => "HEAD", dir);
    expect(key).not.toBeNull();
    const parts = (key as string).split(":");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });

  it("is stable across identical invocations (same state → same key)", () => {
    const dir = initGitRepo();
    const key1 = computeVerdictKey(() => "HEAD", dir);
    const key2 = computeVerdictKey(() => "HEAD", dir);
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).toEqual(key2);
  });

  it("is stable even when untracked files change in a different cwd", () => {
    const dir = initGitRepo();
    const probe = join(process.cwd(), `verdict-key-probe-${Date.now()}.tmp`);
    const key1 = computeVerdictKey(() => "HEAD", dir);
    writeFileSync(probe, "noise");
    const key2 = computeVerdictKey(() => "HEAD", dir);
    if (existsSync(probe)) unlinkSync(probe);
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).toEqual(key2);
  });

  it("changes when the base ref changes", () => {
    const dir = initGitRepo();
    spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "second"], {
      cwd: dir,
      env: cleanGitEnv(),
    });
    const key1 = computeVerdictKey(() => "HEAD~1", dir);
    const key2 = computeVerdictKey(() => "HEAD", dir);
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).not.toEqual(key2);
  });
});
