/**
 * Spawn-path integration for the two-tier GitHub credential policy (#1510).
 *
 * The unit-level allow/deny table lives in `gh-token.spec.ts`. This file proves
 * the wiring: that the decision actually lands in the child env, and that the
 * token reaches *only* the child env — never the daemon log ring, a session
 * event, a monitor event, a stderr line, or anything the daemon persists.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import { capturingLogger, silentLogger } from "@mcp-cli/core";
import type { GhTokenSource } from "./gh-token";
import type { SessionEvent } from "./session-state";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

const WORKER_TOKEN = "ghp_workerworkerworkerworkerworkerworker";
const ADMIN_TOKEN = "ghp_adminadminadminadminadminadminadmin1";
const WORKTREE_PATH = "/repo/.claude/worktrees/issue-1510";

function mockSpawn(): {
  spawn: SpawnFn;
  lastEnv: () => Record<string, string | undefined> | undefined;
} {
  let lastEnv: Record<string, string | undefined> | undefined;
  const spawn = ((_cmd: string[], opts: { env?: Record<string, string | undefined> }) => {
    lastEnv = opts?.env;
    let exitResolve: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });
    // Resolve `exited` on kill so teardown doesn't wait on a process that
    // never existed.
    return { pid: 4242, exited, kill: () => exitResolve(143) };
  }) as SpawnFn;
  return { spawn, lastEnv: () => lastEnv };
}

let server: ClaudeWsServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnWith(
  tokens: GhTokenSource,
  config: { worktree?: string; cwd?: string },
): Promise<{ env: Record<string, string | undefined> | undefined }> {
  const ms = mockSpawn();
  server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger, ghTokens: () => tokens });
  await server.start();
  server.prepareSession("gh-token-session", { prompt: "Hello", ...config });
  server.spawnClaude("gh-token-session");
  return { env: ms.lastEnv() };
}

describe("spawnClaude — GitHub credential tier", () => {
  test("worktree worker gets the write-scoped token in GH_TOKEN and GITHUB_TOKEN", async () => {
    const { env } = await spawnWith(
      { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN },
      {
        worktree: "issue-1510",
        cwd: WORKTREE_PATH,
      },
    );

    expect(env?.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(env?.GITHUB_TOKEN).toBe(WORKER_TOKEN);
    // The admin token is configured but must not reach the child under any name.
    expect(Object.values(env ?? {})).not.toContain(ADMIN_TOKEN);
    expect(env?.MCX_GH_TOKEN_ORCHESTRATOR).toBeUndefined();
    // The unrelated env concerns still contribute their own keys.
    expect(env?.GIT_DIR).toBe(`${WORKTREE_PATH}/.git`);
  });

  test("worker with only an admin token configured has inherited credentials stripped", async () => {
    const { env } = await spawnWith({ orchestrator: ADMIN_TOKEN }, { worktree: "issue-1510", cwd: WORKTREE_PATH });

    expect(Object.hasOwn(env ?? {}, "GH_TOKEN")).toBe(true);
    expect(env?.GH_TOKEN).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env ?? {})).not.toContain(ADMIN_TOKEN);
  });

  test("non-worktree session keeps the orchestrator tier and gets the admin token", async () => {
    const { env } = await spawnWith({ worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN }, {});

    expect(env?.GH_TOKEN).toBe(ADMIN_TOKEN);
    expect(env?.GITHUB_TOKEN).toBe(ADMIN_TOKEN);
  });

  test("no tokens configured leaves the spawn env untouched (legacy single-token behaviour)", async () => {
    const { env } = await spawnWith({}, { worktree: "issue-1510", cwd: WORKTREE_PATH });

    expect(env).toEqual({ GIT_DIR: `${WORKTREE_PATH}/.git`, GIT_WORK_TREE: WORKTREE_PATH });
  });

  test("single-token mode warns once per daemon, without naming a token", async () => {
    const cap = capturingLogger();
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: cap.logger, ghTokens: () => ({}) });
    await server.start();

    for (const id of ["w1", "w2", "w3"]) {
      server.prepareSession(id, { prompt: "Hello", worktree: "t", cwd: WORKTREE_PATH });
      server.spawnClaude(id);
    }

    const warnings = cap.messages.filter((m) => m.level === "warn" && String(m.args[0]).includes("single-token"));
    expect(warnings).toHaveLength(1);
  });
});

describe("spawnClaude — the worker token never leaves the child env", () => {
  test("no log line, session event, monitor event, or stderr line carries the token", async () => {
    const cap = capturingLogger();
    const ms = mockSpawn();
    const sessionEvents: SessionEvent[] = [];
    const monitorEvents: MonitorEventInput[] = [];
    const stderrLines: string[] = [];

    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: cap.logger,
      ghTokens: () => ({ worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN }),
    });
    server.onSessionEvent = (_id, event) => sessionEvents.push(event);
    server.onMonitorEvent = (input) => monitorEvents.push(input);
    server.onStderrLine = (_id, line) => stderrLines.push(line);
    await server.start();

    server.prepareSession("leak-check", { prompt: "Hello", worktree: "issue-1510", cwd: WORKTREE_PATH });
    server.spawnClaude("leak-check");

    // Precondition: the token really was injected, so a clean sweep below means
    // "not leaked" rather than "never present".
    expect(ms.lastEnv()?.GH_TOKEN).toBe(WORKER_TOKEN);

    // Every daemon-side sink the token could reach. `onSessionEvent` and
    // `onStderrLine` are the daemon's routes into SQLite; `onMonitorEvent` is
    // the route into the event bus; the logger is the route into the daemon
    // log ring buffer and stderr.
    const sinks = [
      JSON.stringify(cap.messages),
      JSON.stringify(sessionEvents),
      JSON.stringify(monitorEvents),
      JSON.stringify(stderrLines),
      JSON.stringify(server.listSessions()),
    ];
    for (const sink of sinks) {
      expect(sink).not.toContain(WORKER_TOKEN);
      expect(sink).not.toContain(ADMIN_TOKEN);
    }

    // And the credential decision is still observable — by mode, not by value.
    expect(cap.texts.some((t) => t.includes("gh credentials: scoped"))).toBe(true);
  });

  test("a spawn error message carries no token material", async () => {
    const throwingSpawn = (() => {
      throw new Error("Failed to spawn claude");
    }) as SpawnFn;
    server = new ClaudeWsServer({
      spawn: throwingSpawn,
      logger: silentLogger,
      ghTokens: () => ({ worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN }),
    });
    await server.start();
    server.prepareSession("spawn-fail", { prompt: "Hello", worktree: "issue-1510", cwd: WORKTREE_PATH });

    let threw = false;
    try {
      server.spawnClaude("spawn-fail");
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      expect(message).toContain("Failed to spawn");
      expect(message).not.toContain(WORKER_TOKEN);
      expect(message).not.toContain(ADMIN_TOKEN);
    }
    expect(threw).toBe(true);
  });
});
