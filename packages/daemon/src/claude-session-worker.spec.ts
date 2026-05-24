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

// ── handlePrompt: auto-revive on disconnected session (#1765) ──

function makeRecordingSpawn(): { spawn: SpawnFn; lastCmd: () => string[] } {
  let lastCmd: string[] = [];
  let exitResolve: (code: number) => void = () => {};
  const spawn: SpawnFn = (cmd) => {
    lastCmd = [...cmd];
    return {
      pid: 42000,
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: () => {
        exitResolve(143);
      },
      stderr: null,
    };
  };
  return { spawn, lastCmd: () => lastCmd };
}

describe("handlePrompt: auto-revive disconnected session (#1765)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  test("revives disconnected session and posts db:upsert with connecting state", async () => {
    const recording = makeRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();

    server.restoreSessions([
      {
        sessionId: "disconnected-send-1",
        pid: null,
        state: "idle",
        model: null,
        cwd: "/repo",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        claudeSessionId: "claude-resume-abc",
      },
    ]);

    const messages: unknown[] = [];
    (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => messages.push(msg);

    const result = await handlePrompt(server, {
      sessionId: "disconnected-send-1",
      prompt: "continue the work",
    });

    // Should succeed (no error)
    expect(result.isError).toBeFalsy();

    // Session should now be in connecting state (revived)
    expect(server.listSessions()[0].state).toBe("connecting");

    // DB should be updated with connecting state
    type UpsertMsg = { type: string; session?: { state?: string } };
    const upsert = messages.find(
      (m) => (m as UpsertMsg).type === "db:upsert" && (m as UpsertMsg).session?.state === "connecting",
    );
    expect(upsert).toBeDefined();

    // Spawn command should include --resume with the claudeSessionId
    const lastCmd = recording.lastCmd();
    expect(lastCmd).toContain("--resume");
    expect(lastCmd).toContain("claude-resume-abc");
  });

  test("returns error when disconnected session has no claudeSessionId", async () => {
    const noopSpawn: SpawnFn = (_cmd) => {
      const { promise: exited, resolve } = Promise.withResolvers<number>();
      return { pid: 1, exited, kill: () => resolve(0), stderr: null };
    };
    server = new ClaudeWsServer({ spawn: noopSpawn, logger: silentLogger });
    await server.start();

    server.restoreSessions([
      {
        sessionId: "disconnected-no-csid",
        pid: null,
        state: "idle",
        model: null,
        cwd: "/repo",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        // no claudeSessionId → null
      },
    ]);

    (globalThis as Record<string, unknown>).postMessage = () => {};

    const result = await handlePrompt(server, {
      sessionId: "disconnected-no-csid",
      prompt: "hello",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("claude session ID");
  });
});

// ── handlePrompt: per-request traceparent propagation (#1244) ──

function makeEnvRecordingSpawn(): {
  spawn: SpawnFn;
  lastEnv: () => Record<string, string | undefined> | undefined;
} {
  let lastEnv: Record<string, string | undefined> | undefined;
  const spawn: SpawnFn = (_cmd, opts) => {
    lastEnv = opts?.env;
    let exitResolve: (code: number) => void = () => {};
    return {
      pid: 42001,
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: () => exitResolve(143),
      stderr: null,
    };
  };
  return { spawn, lastEnv: () => lastEnv };
}

describe("handlePrompt: per-request traceparent propagation (#1244)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  test("passes __traceparent from args as TRACEPARENT env to spawned Claude", async () => {
    const recording = makeEnvRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();

    (globalThis as Record<string, unknown>).postMessage = () => {};

    const tp = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    await handlePrompt(server, { prompt: "hello", __traceparent: tp });

    expect(recording.lastEnv()).toEqual({ TRACEPARENT: tp });
  });

  test("falls back to workerTraceparent when __traceparent is absent", async () => {
    const recording = makeEnvRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();

    (globalThis as Record<string, unknown>).postMessage = () => {};

    const workerTp = `00-${"e".repeat(32)}-${"f".repeat(16)}-01`;
    await handlePrompt(server, { prompt: "hello" }, workerTp);

    // Falls back to the worker-level span traceparent (set via init message in production)
    expect(recording.lastEnv()).toEqual({ TRACEPARENT: workerTp });
  });

  test("uses no TRACEPARENT when both __traceparent and workerTraceparent are absent", async () => {
    const recording = makeEnvRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();

    (globalThis as Record<string, unknown>).postMessage = () => {};

    await handlePrompt(server, { prompt: "hello" });

    expect(recording.lastEnv()).toBeUndefined();
  });
});
