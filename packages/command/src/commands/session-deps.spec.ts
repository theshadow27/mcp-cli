import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLookupFailure } from "@mcp-cli/core";
import { defaultGetDiffStats, defaultGetPrStatus, getGitRoot, parseDiffShortstat } from "./session-deps";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

// ── parseDiffShortstat ──

describe("parseDiffShortstat", () => {
  test("parses full shortstat line", () => {
    expect(parseDiffShortstat(" 4 files changed, 142 insertions(+), 38 deletions(-)\n")).toBe("+142/-38 (4f)");
  });

  test("handles insertions only", () => {
    expect(parseDiffShortstat(" 2 files changed, 50 insertions(+)\n")).toBe("+50/-0 (2f)");
  });

  test("handles deletions only", () => {
    expect(parseDiffShortstat(" 1 file changed, 10 deletions(-)\n")).toBe("+0/-10 (1f)");
  });

  test("returns null for empty or whitespace", () => {
    expect(parseDiffShortstat("")).toBeNull();
    expect(parseDiffShortstat("  \n")).toBeNull();
  });
});

// ── getGitRoot ──

describe("getGitRoot", () => {
  test("returns a string in a git repository", () => {
    const root = getGitRoot();
    expect(typeof root).toBe("string");
  });

  test("returned path is fully symlink-resolved (canonical)", () => {
    const root = getGitRoot();
    if (typeof root !== "string") throw new Error("expected string from getGitRoot");
    expect(realpathSync(root)).toBe(root);
  });

  test("resolves symlinked cwd to the real repo root, not the symlink path", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-session-deps-test-"));
    const real = join(base, "real-dir");
    mkdirSync(real);
    const link = join(base, "link-dir");
    symlinkSync(real, link);

    Bun.spawnSync(["git", "init", "-q"], { cwd: real, env: GIT_ENV });

    const orig = process.cwd();
    process.chdir(link);
    try {
      const root = getGitRoot();
      expect(typeof root).toBe("string");
      if (typeof root !== "string") return;
      expect(root).toBe(realpathSync(real));
      expect(root).not.toContain("link-dir");
    } finally {
      process.chdir(orig);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── defaultGetDiffStats ──

describe("defaultGetDiffStats", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when no changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-diff-test-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: GIT_ENV });
    Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"], { env: GIT_ENV });
    const result = await defaultGetDiffStats(dir);
    expect(result).toBeNull();
  });

  test("returns diff summary for unstaged changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-diff-test-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: GIT_ENV });
    writeFileSync(join(dir, "a.txt"), "hello\n");
    Bun.spawnSync(["git", "-C", dir, "add", "."], { env: GIT_ENV });
    Bun.spawnSync(["git", "-C", dir, "commit", "-m", "add a"], { env: GIT_ENV });
    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    const result = await defaultGetDiffStats(dir);
    expect(typeof result).toBe("string");
    expect(result).toContain("+");
    expect(result).toContain("(1f)");
  });

  test("returns LookupFailure for non-git directory", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-diff-test-"));
    const result = await defaultGetDiffStats(dir);
    expect(isLookupFailure(result)).toBe(true);
  });
});

// ── defaultGetPrStatus ──

describe("defaultGetPrStatus", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns null for detached HEAD (no branch)", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-pr-test-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: GIT_ENV });
    Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"], { env: GIT_ENV });
    Bun.spawnSync(["git", "-C", dir, "checkout", "--detach"], { env: GIT_ENV });
    const result = await defaultGetPrStatus(dir);
    expect(result).toBeNull();
  });

  test("returns LookupFailure or null for local-only branch (no remote)", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-pr-test-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: GIT_ENV });
    Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"], { env: GIT_ENV });
    const result = await defaultGetPrStatus(dir);
    // gh pr list will fail (no remote) → LookupFailure, or return null/empty
    expect(result === null || isLookupFailure(result)).toBe(true);
  });

  test("returns LookupFailure for non-git directory", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-pr-test-"));
    const result = await defaultGetPrStatus(dir);
    expect(isLookupFailure(result)).toBe(true);
  });
});
