import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger } from "@mcp-cli/core";
import { handlePrompt, matchesRepoRoot, matchesScopeRoot } from "./claude-session-worker";
import type { SpawnFn } from "./claude-session/ws-server";
import { ClaudeWsServer } from "./claude-session/ws-server";

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

// ── handlePrompt spawn-failure path (#1836) ──

describe("handlePrompt spawn failure (#1836)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  test("cleans up ghost session and posts db:end when spawnClaude throws", async () => {
    const failingSpawn: SpawnFn = () => {
      throw new Error("spawn failed: too many processes");
    };
    server = new ClaudeWsServer({ spawn: failingSpawn, logger: silentLogger });
    await server.start();

    const messages: unknown[] = [];
    (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => messages.push(msg);

    // handlePrompt re-throws after cleanup so the IPC layer can return an error response
    await expect(handlePrompt(server, { prompt: "hello", cwd: "/tmp/wt" })).rejects.toThrow("spawn failed");

    // Ghost must be removed from the in-memory sessions map
    expect(server.listSessions()).toHaveLength(0);

    // db:end must be posted so the parent worker can mark the DB row ended
    expect(messages.some((m) => (m as { type: string }).type === "db:end")).toBe(true);
  });
});
