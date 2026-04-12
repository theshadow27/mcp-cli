import { describe, expect, test } from "bun:test";
import { matchesRepoRoot, matchesScopeRoot } from "./claude-session-worker";

// ── matchesScopeRoot ──

describe("matchesScopeRoot", () => {
  test("returns true when scopeRoot is undefined (no filter)", () => {
    expect(matchesScopeRoot({ cwd: "/repo/a" }, undefined)).toBe(true);
    expect(matchesScopeRoot(undefined, undefined)).toBe(true);
  });

  test("returns false when session is undefined and scopeRoot is set", () => {
    expect(matchesScopeRoot(undefined, "/repo/a")).toBe(false);
  });

  test("exact cwd match passes", () => {
    expect(matchesScopeRoot({ cwd: "/repo/a" }, "/repo/a")).toBe(true);
  });

  test("cwd under scopeRoot passes via prefix", () => {
    expect(matchesScopeRoot({ cwd: "/repo/a/worktree" }, "/repo/a")).toBe(true);
    expect(matchesScopeRoot({ cwd: "/repo/a/deep/nested" }, "/repo/a")).toBe(true);
  });

  test("partial prefix without slash separator does not pass", () => {
    // /repo/abc should not match /repo/a
    expect(matchesScopeRoot({ cwd: "/repo/abc" }, "/repo/a")).toBe(false);
  });

  test("different repo does not pass", () => {
    expect(matchesScopeRoot({ cwd: "/repo/b" }, "/repo/a")).toBe(false);
    expect(matchesScopeRoot({ cwd: "/repo/b/sub" }, "/repo/a")).toBe(false);
  });

  test("null cwd does not pass", () => {
    expect(matchesScopeRoot({ cwd: null }, "/repo/a")).toBe(false);
  });
});

// ── matchesRepoRoot ──

describe("matchesRepoRoot", () => {
  test("returns true when repoRoot is undefined (no filter)", () => {
    expect(matchesRepoRoot({ repoRoot: "/repo/a", cwd: "/repo/a" }, undefined)).toBe(true);
    expect(matchesRepoRoot(undefined, undefined)).toBe(true);
  });

  test("returns false when session is undefined and repoRoot is set", () => {
    expect(matchesRepoRoot(undefined, "/repo/a")).toBe(false);
  });

  test("matching repoRoot passes", () => {
    expect(matchesRepoRoot({ repoRoot: "/repo/a", cwd: "/repo/a" }, "/repo/a")).toBe(true);
  });

  test("different repoRoot does not pass", () => {
    expect(matchesRepoRoot({ repoRoot: "/repo/b", cwd: "/repo/b" }, "/repo/a")).toBe(false);
  });

  // null-repoRoot fallback: cwd prefix match (#1242, #1308)

  test("null repoRoot falls back to cwd exact match", () => {
    expect(matchesRepoRoot({ repoRoot: null, cwd: "/repo/a" }, "/repo/a")).toBe(true);
  });

  test("null repoRoot falls back to cwd prefix match", () => {
    expect(matchesRepoRoot({ repoRoot: null, cwd: "/repo/a/worktree" }, "/repo/a")).toBe(true);
  });

  test("null repoRoot with cwd in different repo does not pass", () => {
    expect(matchesRepoRoot({ repoRoot: null, cwd: "/repo/b/sub" }, "/repo/a")).toBe(false);
  });

  test("null repoRoot with partial prefix without slash does not pass", () => {
    expect(matchesRepoRoot({ repoRoot: null, cwd: "/repo/abc" }, "/repo/a")).toBe(false);
  });

  test("null repoRoot with null cwd does not pass when filter is set", () => {
    // Ghost sessions (crashed workers) with both fields null are invisible to filtered waits.
    // They remain visible when no filter is active (repoRoot=undefined path above).
    expect(matchesRepoRoot({ repoRoot: null, cwd: null }, "/repo/a")).toBe(false);
  });
});
