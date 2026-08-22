import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, type MonitorEventInput, options, scanSecrets } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { ClaudeWsServer, type SpawnFn } from "./ws-server";

/**
 * Spawn profiles (#935) carry credentials. These tests pin the two properties
 * that make that safe:
 *   1. the values reach the child process env, and
 *   2. they reach NOTHING else — not a log line, not a monitor event, not a
 *      stderr forward, not the session list the CLI renders.
 *
 * The leak assertion is deliberately blunt: capture every observable output the
 * server produces during a profiled spawn and search the lot for the secret.
 */

/** The credential under test. Shaped like a real AWS key so `scanSecrets` also flags it. */
const SECRET_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_TOKEN = "bedrock-bearer-token-4c1f9e2a-do-not-log";

interface Capture {
  logs: string[];
  events: MonitorEventInput[];
  stderr: string[];
  logger: Logger;
}

function makeCapture(): Capture {
  const logs: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      logs.push(`${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  return {
    logs,
    events: [],
    stderr: [],
    logger: { error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug") },
  };
}

/** Everything the server said, as one blob to search for leaked values. */
function allOutput(capture: Capture, extra: unknown[] = []): string {
  return [
    ...capture.logs,
    ...capture.stderr,
    JSON.stringify(capture.events),
    ...extra.map((e) => JSON.stringify(e)),
  ].join("\n");
}

/** Mock spawn that records the env handed to the child and never launches anything. */
function recordingSpawn(): { spawn: SpawnFn; env: () => Record<string, string | undefined> } {
  let captured: Record<string, string | undefined> = {};
  const spawn = ((_cmd: string[], opts: { env?: Record<string, string | undefined> }) => {
    captured = opts.env ?? {};
    let exitResolve: (code: number) => void = () => {};
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    return {
      pid: 4242,
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: () => {
        // Teardown must actually finish: closing stdout ends the stdio reader
        // and resolving `exited` releases stop()'s await.
        const ctrl = stdoutController;
        stdoutController = null;
        ctrl?.close();
        exitResolve(143);
      },
      stdout,
      stdin: { write: () => 0, flush: () => 0 },
      stderrTail: () => "",
    };
  }) as SpawnFn;
  return { spawn, env: () => captured };
}

function writeProfile(name: string, text: string): void {
  mkdirSync(options.PROFILES_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.PROFILES_DIR, `${name}.env`), text, { mode: 0o600 });
}

describe("spawnClaude with a profile (#935)", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("applies the profile's env to the child and leaks no value anywhere else", async () => {
    using _opts = testOptions();
    writeProfile(
      "bedrock",
      [
        "# bedrock worker credentials",
        "CLAUDE_CODE_USE_BEDROCK=1",
        "AWS_REGION=us-east-1",
        `AWS_ACCESS_KEY_ID=${SECRET_KEY}`,
        `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}`,
      ].join("\n"),
    );

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    server.onMonitorEvent = (input) => capture.events.push(input);
    server.onStderrLine = (_id, line) => capture.stderr.push(line);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "bedrock" });
    server.spawnClaude(sessionId);

    // 1. The values did reach the child.
    const env = mock.env();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_ACCESS_KEY_ID).toBe(SECRET_KEY);
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe(SECRET_TOKEN);

    // 2. And nowhere else. The session list is included because it is what
    //    `mcx claude ls` prints and what the daemon persists to SQLite.
    const output = allOutput(capture, server.listSessions());
    expect(output).not.toContain(SECRET_KEY);
    expect(output).not.toContain(SECRET_TOKEN);
    expect(scanSecrets(output).clean).toBe(true);

    // The name and the key NAMES are logged — that is the diagnostic that
    // answers "why is this worker on Bedrock?" without printing a credential.
    expect(capture.logs.join("\n")).toContain('using profile "bedrock"');
    expect(capture.logs.join("\n")).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("a spawn without a profile gets none of the profile's vars", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}\n`);

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" });
    server.spawnClaude(sessionId);

    expect(mock.env().AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  test("a missing profile fails the spawn instead of silently using the bare daemon env", async () => {
    using _opts = testOptions();
    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "gone" });
    // Falling back to the unprofiled env is exactly the failure mode #935 exists
    // to remove: the worker would run on the quota-capped account and say nothing.
    expect(() => server?.spawnClaude(sessionId)).toThrow(/profile "gone" not found/);
  });

  test("a malformed profile fails the spawn without echoing the offending line", async () => {
    using _opts = testOptions();
    writeProfile("broken", `AWS_REGION=us-east-1\n${SECRET_TOKEN}\n`);

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "broken" });
    const spawnBroken = () => server?.spawnClaude(sessionId);
    // Points at the line, does not quote it.
    expect(spawnBroken).toThrow("broken.env:2");
    expect(spawnBroken).not.toThrow(SECRET_TOKEN);
    expect(allOutput(capture)).not.toContain(SECRET_TOKEN);
  });

  test("warns (by path, not by value) when the profile file is group-readable", async () => {
    using _opts = testOptions();
    mkdirSync(options.PROFILES_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(options.PROFILES_DIR, "loose.env"), `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}\n`, {
      mode: 0o644,
    });

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "loose" });
    server.spawnClaude(sessionId);

    const warnings = capture.logs.filter((l) => l.startsWith("warn"));
    expect(warnings.join("\n")).toContain("chmod 600");
    expect(allOutput(capture)).not.toContain(SECRET_TOKEN);
  });
  test("emits a spawn-override event naming the profile — name and source only", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}\n`);

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    server.onMonitorEvent = (input) => capture.events.push(input);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "bedrock", profileSource: "flag" });
    server.spawnClaude(sessionId);

    // Without this, nothing anywhere records which credentials a session ran
    // under — which is what made a silently-stripped profile undiagnosable.
    const override = capture.events.find((e) => e.profile !== undefined);
    expect(override?.profile).toBe("bedrock");
    expect(override?.profileSource).toBe("flag");
    expect(JSON.stringify(capture.events)).not.toContain(SECRET_TOKEN);
  });

  test("an empty profile file fails the spawn instead of reporting success", async () => {
    using _opts = testOptions();
    writeProfile("blank", "# TODO: fill in\n");

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "blank" });
    // It used to log `using profile "blank" (0 vars: )` and run bare.
    expect(() => server?.spawnClaude(sessionId)).toThrow(/defines no variables/);
  });

  test("a bare KEY line UNSETS an inherited daemon credential", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", "CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_API_KEY\n");

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: capture.logger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio", profile: "bedrock" });
    server.spawnClaude(sessionId);

    // `{ ...process.env, ...envOverrides }` with an undefined value drops the key
    // (the same mechanism the CLAUDECODE strip uses). If the daemon was started
    // from a shell holding a subscription token, the Bedrock child must not carry
    // both credential sets and let the CLI's internal precedence pick a winner.
    const env = mock.env();
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });
});

/**
 * A daemon restart is the project's own standard recovery action, and it was the
 * one that silently stripped the profile: `restoreSessions` rebuilt the session
 * config without it, `reviveSession` never re-resolved, and the respawn produced
 * output byte-identical to a correct one. These pin the fix at both ends —
 * the name survives the restart, and any path that arrives without one resolves
 * rather than assuming "none".
 */
describe("spawnClaude profile resolution on restore/revive (#935)", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  function makeServer(capture: Capture, spawn: SpawnFn): ClaudeWsServer {
    return new ClaudeWsServer({ spawn, logger: capture.logger, connectTimeoutMs: 5000 });
  }

  /** Restore one disconnected session with a claudeSessionId so it can be revived. */
  function restoreOne(srv: ClaudeWsServer, sessionId: string): void {
    srv.restoreSessions([
      {
        sessionId,
        pid: null,
        state: "disconnected",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        claudeSessionId: "claude-abc",
        transport: "stdio",
      },
    ]);
  }

  test("a revived session RE-RESOLVES its profile rather than respawning bare", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}\n`);
    writeFileSync(options.MCP_CLI_CONFIG_PATH, JSON.stringify({ defaultProfile: "bedrock" }));

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = makeServer(capture, mock.spawn);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    restoreOne(server, sessionId); // the session row carries no profile
    server.reviveSession(sessionId, "continue");

    expect(mock.env().AWS_BEARER_TOKEN_BEDROCK).toBe(SECRET_TOKEN);
  });

  test("a spawn path that never resolved a profile still gets the config default", async () => {
    // The guarantee the precedence function could not make on its own: blockers 1
    // and 2 were both "a spawn path that skipped the resolver". spawnClaude is
    // the one place every path passes through, so it resolves rather than
    // spawning bare — a future caller that forgets cannot silently downgrade.
    using _opts = testOptions();
    writeProfile("bedrock", `AWS_BEARER_TOKEN_BEDROCK=${SECRET_TOKEN}\n`);
    writeFileSync(options.MCP_CLI_CONFIG_PATH, JSON.stringify({ defaultProfile: "bedrock" }));

    const capture = makeCapture();
    const mock = recordingSpawn();
    server = makeServer(capture, mock.spawn);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" }); // no profile passed
    server.spawnClaude(sessionId);

    expect(mock.env().AWS_BEARER_TOKEN_BEDROCK).toBe(SECRET_TOKEN);
    expect(allOutput(capture, server.listSessions())).not.toContain(SECRET_TOKEN);
  });

  test("an unprofiled spawn says so, so a stripped profile has a signature in the log", async () => {
    using _opts = testOptions();
    const capture = makeCapture();
    const mock = recordingSpawn();
    server = makeServer(capture, mock.spawn);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" });
    server.spawnClaude(sessionId);

    // A correct spawn and a profile-stripped respawn used to be byte-identical.
    expect(capture.logs.join("\n")).toContain("spawning with no profile");
  });
});
