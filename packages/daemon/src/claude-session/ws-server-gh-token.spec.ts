/**
 * Spawn-path integration for the GitHub credential policy (#1510).
 *
 * The allow/deny table itself lives in `gh-token.spec.ts`. This file proves the
 * wiring: that the decision lands in the child env, that the tier is recorded
 * durably on the event bus rather than only in the evicting log ring, and that
 * the token reaches *only* the child env.
 *
 * Every sink in the leak sweep is asserted non-empty first. An earlier revision
 * swept three structurally-empty arrays, which reads as coverage while being
 * incapable of regressing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import { SESSION_GH_CREDENTIALS, capturingLogger, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../../test/harness";
import type { GhTokenConfig } from "./gh-token";
import type { SessionEvent } from "./session-state";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

const WORKER_TOKEN = "ghp_workerworkerworkerworkerworkerworker";
const ADMIN_TOKEN = "ghp_adminadminadminadminadminadminadmin1";
const WORKTREE_PATH = "/repo/.claude/worktrees/issue-1510";

/**
 * A mock child that behaves like a real one on the two axes this file cares
 * about: it writes to its stderr tap, and it exits. Both are what make the
 * daemon-side sinks reachable — without stderr `stderrLines` stays empty, and
 * without an exit the session state machine never produces an event, so a leak
 * sweep over either cannot fail.
 */
function mockSpawn(opts: { stderr?: string; exitCode?: number } = {}): {
  spawn: SpawnFn;
  lastEnv: () => Record<string, string | undefined> | undefined;
} {
  let lastEnv: Record<string, string | undefined> | undefined;
  const spawn = ((_cmd: string[], o: Parameters<SpawnFn>[1]) => {
    lastEnv = o?.env;
    let exitResolve: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      exitResolve = r;
    });

    if (opts.stderr !== undefined) {
      o?.onStderr?.(`${opts.stderr}\n`);
      o?.onStderrEnd?.();
    }
    if (opts.exitCode !== undefined) queueMicrotask(() => exitResolve(opts.exitCode ?? 0));

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
  config: GhTokenConfig,
  sessionConfig: { worktree?: string; cwd?: string },
): Promise<{ env: Record<string, string | undefined> | undefined; monitorEvents: MonitorEventInput[] }> {
  const ms = mockSpawn();
  const monitorEvents: MonitorEventInput[] = [];
  server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger, ghTokens: () => config });
  server.onMonitorEvent = (input) => monitorEvents.push(input);
  await server.start();
  server.prepareSession("gh-token-session", { prompt: "Hello", ...sessionConfig });
  server.spawnClaude("gh-token-session");
  return { env: ms.lastEnv(), monitorEvents };
}

describe("spawnClaude — every spawned session is a worker", () => {
  // The defect this replaced keyed the tier on `config.worktree`, an optional
  // caller-supplied label. `mcx claude resume` never sets it and `--cwd`-only
  // spawns omit it, so both were promoted to the admin tier. These cases pin
  // the inverted default: the shape of the spawn request cannot buy privilege.
  const SHAPES: Array<[string, { worktree?: string; cwd?: string }]> = [
    ["a --worktree spawn", { worktree: "issue-1510", cwd: WORKTREE_PATH }],
    ["a --cwd-only spawn (no worktree flag)", { cwd: WORKTREE_PATH }],
    ["a resume-shaped spawn (cwd set, worktree omitted)", { cwd: "/repo" }],
    ["a bare spawn with neither field", {}],
  ];

  test.each(SHAPES)("%s gets the worker token, never the admin token", async (_label, sessionConfig) => {
    const { env } = await spawnWith({ tokens: { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN } }, sessionConfig);

    expect(env?.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(env?.GITHUB_TOKEN).toBe(WORKER_TOKEN);
    expect(Object.values(env ?? {})).not.toContain(ADMIN_TOKEN);
  });

  test.each(SHAPES)("%s with only an admin token configured is denied", async (_label, sessionConfig) => {
    const { env } = await spawnWith({ tokens: { orchestrator: ADMIN_TOKEN } }, sessionConfig);

    expect(env?.GH_TOKEN).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env ?? {})).not.toContain(ADMIN_TOKEN);
    expect(env?.MCX_GH_CREDENTIALS).toBe("denied");
  });

  test("the worktree pin still contributes its own keys alongside the credential block", async () => {
    const { env } = await spawnWith(
      { tokens: { worker: WORKER_TOKEN } },
      { worktree: "issue-1510", cwd: WORKTREE_PATH },
    );

    expect(env?.GIT_DIR).toBe(`${WORKTREE_PATH}/.git`);
    expect(env?.GIT_WORK_TREE).toBe(WORKTREE_PATH);
  });
});

describe("spawnClaude — denied actually denies", () => {
  test("a denied child cannot reach gh's hosts.yml or a git credential helper", async () => {
    const { env } = await spawnWith({ tokens: { orchestrator: ADMIN_TOKEN } }, { cwd: WORKTREE_PATH });

    // Unsetting GH_TOKEN alone would leave `gh` reading ~/.config/gh/hosts.yml
    // and `git push` reaching the same credential through credential.helper.
    expect(env?.GH_CONFIG_DIR).toContain("gh-isolated");
    expect(env?.GIT_CONFIG_COUNT).toBe("2");
    expect(env?.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env?.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect([env?.GIT_CONFIG_VALUE_0, env?.GIT_CONFIG_VALUE_1]).toEqual(["", ""]);
  });

  test("a scoped child keeps exactly one helper, so git push uses the worker token", async () => {
    const { env } = await spawnWith({ tokens: { worker: WORKER_TOKEN } }, { cwd: WORKTREE_PATH });

    expect(env?.GH_CONFIG_DIR).toContain("gh-isolated");
    expect(env?.GIT_CONFIG_COUNT).toBe("3");
    expect(env?.GIT_CONFIG_VALUE_2).toBe("!gh auth git-credential");
  });

  test("the reason reaches the child, not just the daemon log", async () => {
    // A denied worker loses `gh pr create` and `git push`. Discovering that as a
    // bare 401 is how a worker ends up working around the boundary.
    const { env } = await spawnWith({ tokens: { orchestrator: ADMIN_TOKEN } }, { cwd: WORKTREE_PATH });

    expect(env?.MCX_GH_CREDENTIALS).toBe("denied");
    expect(env?.MCX_GH_CREDENTIALS_REASON).toContain("never shared with a child");
    expect(env?.MCX_GH_CREDENTIALS_REASON).not.toContain(ADMIN_TOKEN);
  });

  test("an untrusted tokens file denies every spawn instead of inheriting ambient credentials", async () => {
    const { env } = await spawnWith(
      { tokens: {}, problem: "/home/agent/.mcp-cli/tokens.json is mode 0644" },
      { worktree: "issue-1510", cwd: WORKTREE_PATH },
    );

    expect(env?.MCX_GH_CREDENTIALS).toBe("denied");
    expect(env?.GH_TOKEN).toBeUndefined();
    expect(env?.GH_CONFIG_DIR).toContain("gh-isolated");
  });
});

describe("spawnClaude — legacy and operator signalling", () => {
  test("no tokens configured leaves the spawn env untouched (legacy single-token behaviour)", async () => {
    const { env } = await spawnWith({ tokens: {} }, { worktree: "issue-1510", cwd: WORKTREE_PATH });

    expect(env).toEqual({ GIT_DIR: `${WORKTREE_PATH}/.git`, GIT_WORK_TREE: WORKTREE_PATH });
  });

  test("single-token mode warns once per daemon, without naming a token", async () => {
    const cap = capturingLogger();
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: cap.logger, ghTokens: () => ({ tokens: {} }) });
    await server.start();

    for (const id of ["w1", "w2", "w3"]) {
      server.prepareSession(id, { prompt: "Hello", worktree: "t", cwd: WORKTREE_PATH });
      server.spawnClaude(id);
    }

    const warnings = cap.messages.filter((m) => m.level === "warn" && String(m.args[0]).includes("single-token"));
    expect(warnings).toHaveLength(1);
  });

  test("a rejected tokens file logs an error on EVERY spawn — the warning latch does not swallow it", async () => {
    // A latch that fires once per daemon is useless on a box whose daemon uptime
    // is days: the absence of a warning carries no information.
    const cap = capturingLogger();
    const ms = mockSpawn();
    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: cap.logger,
      ghTokens: () => ({ tokens: {}, problem: "/home/agent/.mcp-cli/tokens.json is mode 0644" }),
    });
    await server.start();

    for (const id of ["w1", "w2", "w3"]) {
      server.prepareSession(id, { prompt: "Hello", cwd: WORKTREE_PATH });
      server.spawnClaude(id);
    }

    const errors = cap.messages.filter((m) => m.level === "error" && String(m.args[0]).includes("0644"));
    expect(errors).toHaveLength(3);
  });

  test("the tier is recorded on the event bus, which does not evict like the log ring", async () => {
    const { monitorEvents } = await spawnWith({ tokens: { worker: WORKER_TOKEN } }, { cwd: WORKTREE_PATH });

    const event = monitorEvents.find((e) => e.event === SESSION_GH_CREDENTIALS);
    expect(event).toBeDefined();
    expect(event?.mode).toBe("scoped");
    expect(event?.sessionId).toBe("gh-token-session");
    // Secret-free by construction — this is the whole reason it is safe to emit.
    expect(JSON.stringify(event)).not.toContain(WORKER_TOKEN);
  });

  test("an inherited spawn is recorded too, so 'no event' never means 'no decision'", async () => {
    const { monitorEvents } = await spawnWith({ tokens: {} }, { cwd: WORKTREE_PATH });

    expect(monitorEvents.find((e) => e.event === SESSION_GH_CREDENTIALS)?.mode).toBe("inherited");
  });
});

describe("spawnClaude — the worker token never leaves the child env", () => {
  test("no log line, session event, monitor event, stderr line, or session row carries the token", async () => {
    const cap = capturingLogger();
    // `stderr` makes the forwarded-stderr sink reachable; `exitCode` drives the
    // session state machine so the session-event sink is reachable too.
    const ms = mockSpawn({ stderr: "claude: something went wrong", exitCode: 1 });
    const sessionEvents: SessionEvent[] = [];
    const monitorEvents: MonitorEventInput[] = [];
    const stderrLines: string[] = [];

    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: cap.logger,
      ghTokens: () => ({ tokens: { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN } }),
    });
    server.onSessionEvent = (_id, event) => sessionEvents.push(event);
    server.onMonitorEvent = (input) => monitorEvents.push(input);
    server.onStderrLine = (_id, line) => stderrLines.push(line);
    await server.start();

    server.prepareSession("leak-check", { prompt: "Hello", worktree: "issue-1510", cwd: WORKTREE_PATH });
    server.spawnClaude("leak-check");

    // Precondition: the token really was injected, so a clean sweep means "not
    // leaked" rather than "never present".
    expect(ms.lastEnv()?.GH_TOKEN).toBe(WORKER_TOKEN);
    // And every sink is actually carrying traffic before we sweep it.
    await pollUntil(() => stderrLines.length > 0);
    await pollUntil(() => sessionEvents.length > 0);

    const sinks: Array<[string, string]> = [
      ["daemon log ring", JSON.stringify(cap.messages)],
      ["session events (route into SQLite)", JSON.stringify(sessionEvents)],
      ["monitor events (route into the event bus)", JSON.stringify(monitorEvents)],
      ["forwarded child stderr", JSON.stringify(stderrLines)],
      ["listSessions (the IPC surface)", JSON.stringify(server.listSessions())],
    ];

    for (const [label, sink] of sinks) {
      // A sweep over an empty array cannot regress. Every sink must be carrying
      // something for its assertion to mean anything.
      expect(`${label}: ${sink}`).not.toBe(`${label}: []`);
      expect(sink).not.toContain(WORKER_TOKEN);
      expect(sink).not.toContain(ADMIN_TOKEN);
    }

    // The decision is still observable — by mode, not by value.
    expect(cap.texts.some((t) => t.includes("gh credentials: scoped"))).toBe(true);
  });

  test("the stderr sweep has teeth: a token on that path IS caught", async () => {
    // Negative control for the sweep above. If token material ever reached the
    // forwarded-stderr path, the identical assertion would fail — proving the
    // clean result there is "not leaked" and not "sink never populated". The
    // previous revision could not show this: three of its five sinks were
    // structurally empty, so their assertions were incapable of regressing.
    const ms = mockSpawn({ stderr: `claude: auth failed using ${WORKER_TOKEN}`, exitCode: 1 });
    const stderrLines: string[] = [];
    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: silentLogger,
      ghTokens: () => ({ tokens: { worker: WORKER_TOKEN } }),
    });
    server.onStderrLine = (_id, line) => stderrLines.push(line);
    await server.start();

    server.prepareSession("teeth-check", { prompt: "Hello", cwd: WORKTREE_PATH });
    server.spawnClaude("teeth-check");
    await pollUntil(() => stderrLines.length > 0);

    expect(JSON.stringify(stderrLines)).toContain(WORKER_TOKEN);
  });
});
