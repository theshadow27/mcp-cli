import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@mcp-cli/core";
import { options, silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import {
  handlePrompt,
  makeEventInScope,
  matchesRepoRoot,
  refreshClaudeResolutionIfDisabled,
} from "./claude-session-worker";
import type { ClaudeResolution } from "./claude-session/binary-resolver";
import type { SpawnFn } from "./claude-session/ws-server";
import { ClaudeWsServer } from "./claude-session/ws-server";
import { ensureSelfSignedCert } from "./tls/self-signed";

// ── makeEventInScope ──

describe("makeEventInScope", () => {
  const session = (domainId: number, repoRoot: string) => ({
    session: { domainId, repoRoot, cwd: repoRoot } as SessionInfo,
  });

  test("no domain and no repoRoot is no filter — everything wakes the caller", () => {
    const inScope = makeEventInScope(undefined, undefined);
    expect(inScope(session(7, "/repo/a"))).toBe(true);
    expect(inScope({})).toBe(true);
  });

  test("a domain filter admits only that domain", () => {
    const inScope = makeEventInScope(7, undefined);
    expect(inScope(session(7, "/repo/a"))).toBe(true);
    expect(inScope(session(8, "/repo/a"))).toBe(false);
  });

  test("an event with no session is dropped whenever a filter is active (#1308)", () => {
    expect(makeEventInScope(7, undefined)({})).toBe(false);
    expect(makeEventInScope(undefined, "/repo/a")({})).toBe(false);
  });

  test("domain wins over repoRoot when both are set", () => {
    // Same repo, different domain: the domain is the partition key, so this is
    // out of scope even though the coarser repo filter would have admitted it.
    const inScope = makeEventInScope(7, "/repo/a");
    expect(inScope(session(8, "/repo/a"))).toBe(false);
    expect(inScope(session(7, "/repo/a"))).toBe(true);
  });

  test("falls back to repoRoot when no domain resolved", () => {
    const inScope = makeEventInScope(undefined, "/repo/a");
    expect(inScope(session(0, "/repo/a"))).toBe(true);
    expect(inScope(session(0, "/repo/b"))).toBe(false);
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

// ── handlePrompt: per-spawn binary/transport override (#2681) ──

describe("handlePrompt: per-spawn binary/transport override (#2681)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  test("caller-supplied binary/transport win over the startup default and stay frozen across a respawn after the global binary changes", async () => {
    const recording = makeRecordingSpawn();
    // Daemon's startup-resolved binary (the "pinned grid" default).
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger, binaryPath: "/startup/claude" });
    await server.start();

    const messages: unknown[] = [];
    (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => messages.push(msg);

    const result = await handlePrompt(server, {
      prompt: "canary run",
      claudeBinary: "/canary/2.1.170",
      transport: "stdio",
    });
    const { sessionId } = JSON.parse(result.content[0].text) as { sessionId: string };

    // The caller-supplied binary is spawned — not the startup default.
    const cmd = recording.lastCmd();
    expect(cmd[0]).toBe("/canary/2.1.170");
    // stdio transport: no --sdk-url WS bootstrap.
    expect(cmd).not.toContain("--sdk-url");

    // The session is recorded with the stdio transport (carried on the db:upsert).
    type UpsertMsg = { type: string; session?: { transport?: string } };
    const transportUpsert = messages.find(
      (m) => (m as UpsertMsg).type === "db:upsert" && (m as UpsertMsg).session?.transport !== undefined,
    ) as UpsertMsg | undefined;
    expect(transportUpsert?.session?.transport).toBe("stdio");

    // Mutate the channel the spawn path actually consults as the "global" binary —
    // the server's startup-resolved `binaryPath`, used via `config.binaryPath ?? this.binaryPath`.
    (server as unknown as { binaryPath: string }).binaryPath = "/global/changed/claude";

    // Respawn the same session (re-runs buildSpawnCmd). The per-session override was frozen
    // onto session.config at dispatch, so it must still win over the mutated global default.
    server.spawnClaude(sessionId);
    expect(recording.lastCmd()[0]).toBe("/canary/2.1.170");
  });

  test("explicit --transport sdk-url override spawns the WS bootstrap (--sdk-url) and records ws", async () => {
    const recording = makeRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger, binaryPath: "/startup/claude" });
    await server.start();

    const messages: unknown[] = [];
    (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => messages.push(msg);

    await handlePrompt(server, { prompt: "canary run", transport: "sdk-url" });

    // sdk-url maps to the WS transport: --sdk-url present in the spawn cmd.
    expect(recording.lastCmd()).toContain("--sdk-url");

    type UpsertMsg = { type: string; session?: { transport?: string } };
    const transportUpsert = messages.find(
      (m) => (m as UpsertMsg).type === "db:upsert" && (m as UpsertMsg).session?.transport !== undefined,
    ) as UpsertMsg | undefined;
    expect(transportUpsert?.session?.transport).toBe("ws");
  });

  test("omitting overrides preserves the pinned default (startup binary + sdk-url WS)", async () => {
    const recording = makeRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger, binaryPath: "/startup/claude" });
    await server.start();

    const messages: unknown[] = [];
    (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => messages.push(msg);

    await handlePrompt(server, { prompt: "normal run" });

    const cmd = recording.lastCmd();
    expect(cmd[0]).toBe("/startup/claude");
    expect(cmd).toContain("--sdk-url");

    type UpsertMsg = { type: string; session?: { transport?: string } };
    const transportUpsert = messages.find(
      (m) => (m as UpsertMsg).type === "db:upsert" && (m as UpsertMsg).session?.transport !== undefined,
    ) as UpsertMsg | undefined;
    expect(transportUpsert?.session?.transport).toBe("ws");
  });

  test("binary override spawns even when the daemon's default binary is unresolved (spawn disabled)", async () => {
    const recording = makeRecordingSpawn();
    server = new ClaudeWsServer({
      spawn: recording.spawn,
      logger: silentLogger,
      spawnDisabledReason: "claude 2.1.123 requires a patched copy",
    });
    await server.start();

    (globalThis as Record<string, unknown>).postMessage = () => {};

    const result = await handlePrompt(server, {
      prompt: "canary run",
      claudeBinary: "/canary/2.1.170",
      transport: "stdio",
    });

    expect(result.isError).toBeFalsy();
    expect(recording.lastCmd()[0]).toBe("/canary/2.1.170");
  });
});

// ── handlePrompt: spawn profile precedence (#935) ──

/**
 * Precedence is resolved in the worker, not the CLI, so that internal callers
 * (phase scripts, `mcx memory`'s audit, any direct callTool) get the same answer
 * as `mcx claude spawn`. These tests drive the real RPC entry point and assert on
 * the env that actually reached the child (reusing `makeEnvRecordingSpawn` above).
 */
describe("handlePrompt: spawn profile precedence (#935)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  /** Temp state dir with profiles, a real repo carrying a `.mcx.yaml`, and a config default. */
  function setupProfiles(configDefault?: string, manifestProfile = "from-manifest") {
    const opts = testOptions();
    mkdirSync(options.PROFILES_DIR, { recursive: true, mode: 0o700 });
    for (const name of ["from-flag", "from-manifest", "from-config"]) {
      writeFileSync(join(options.PROFILES_DIR, `${name}.env`), `AWS_TEST_PROFILE=${name}\n`, { mode: 0o600 });
    }
    // A real checkout: the manifest search is bounded by `findWorktreeRoot`, so
    // a bare directory has no manifest layer at all.
    const repo = join(opts.dir, "repo");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".mcx.yaml"), `version: 1\nprofile: ${manifestProfile}\ninitial: impl\nphases: {}\n`);
    if (configDefault) {
      writeFileSync(options.MCP_CLI_CONFIG_PATH, JSON.stringify({ defaultProfile: configDefault }));
    }
    return { opts, repo };
  }

  async function spawnWith(args: Record<string, unknown>): Promise<Record<string, string | undefined>> {
    const recording = makeEnvRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();
    (globalThis as Record<string, unknown>).postMessage = () => {};
    const result = await handlePrompt(server, { prompt: "hi", transport: "stdio", ...args });
    expect(result.isError).toBeFalsy();
    return recording.lastEnv() ?? {};
  }

  test("--profile beats the config default", async () => {
    const { opts, repo } = setupProfiles("from-config");
    using _opts = opts;
    const env = await spawnWith({ cwd: repo, profile: "from-flag" });
    expect(env.AWS_TEST_PROFILE).toBe("from-flag");
  });

  test("a NAMED profile in the repo manifest does NOT beat the config default — it is ignored", async () => {
    // Deselect-only. A `.mcx.yaml` arrives by `git clone`; letting it select
    // credentials would let a third-party checkout pick which account an
    // auto-approving agent spawns with, and where ANTHROPIC_BASE_URL sends it.
    const { opts, repo } = setupProfiles("from-config");
    using _opts = opts;
    const env = await spawnWith({ cwd: repo });
    expect(env.AWS_TEST_PROFILE).toBe("from-config");
  });

  test("`profile: null` in the repo manifest DOES override the config default", async () => {
    // The half that stays: a repo may always opt out.
    const { opts, repo } = setupProfiles("from-config", "null");
    using _opts = opts;
    const env = await spawnWith({ cwd: repo });
    expect(env.AWS_TEST_PROFILE).toBeUndefined();
  });

  test("the config default applies outside a repo — an internal caller cannot forget it", async () => {
    const { opts } = setupProfiles("from-config");
    using _opts = opts;
    const env = await spawnWith({ cwd: opts.dir });
    expect(env.AWS_TEST_PROFILE).toBe("from-config");
  });

  test("no layer set means the bare daemon env", async () => {
    const { opts } = setupProfiles();
    using _opts = opts;
    const env = await spawnWith({ cwd: opts.dir });
    expect(env.AWS_TEST_PROFILE).toBeUndefined();
  });

  test("profile: null (--no-profile) opts out even with a config default", async () => {
    const { opts, repo } = setupProfiles("from-config");
    using _opts = opts;
    const env = await spawnWith({ cwd: repo, profile: null });
    expect(env.AWS_TEST_PROFILE).toBeUndefined();
  });

  test("--profile on a prompt to an existing session is refused, not silently dropped", async () => {
    // It used to be validated by the CLI and then discarded, because a sessionId
    // short-circuits before the resolver runs: positive confirmation, no effect.
    const { opts } = setupProfiles("from-config");
    using _opts = opts;
    const recording = makeEnvRecordingSpawn();
    server = new ClaudeWsServer({ spawn: recording.spawn, logger: silentLogger });
    await server.start();
    (globalThis as Record<string, unknown>).postMessage = () => {};
    const result = await handlePrompt(server, {
      prompt: "hi",
      sessionId: crypto.randomUUID(),
      profile: "from-flag",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be applied to an existing session");
  });
});

// ── Stale spawn resolution refresh (#3013) ──

describe("refreshClaudeResolutionIfDisabled (#3013)", () => {
  let server: ClaudeWsServer | undefined;
  const origPostMessage = (globalThis as Record<string, unknown>).postMessage;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    (globalThis as Record<string, unknown>).postMessage = origPostMessage;
  });

  const STALE_REASON =
    "claude 2.1.235 differs from the patched copy (2.1.234). claude was likely auto-updated. " +
    "Run `mcx claude patch-update` to refresh the patched copy.";

  const staleResolution = (): ClaudeResolution => ({
    error: STALE_REASON,
    reason: "patch-stale",
    version: "2.1.235",
    tlsConfig: { cert: "cert", key: "key" },
    listenerTls: "wss",
  });

  const freshResolution = (): ClaudeResolution => ({
    binaryPath: "/store/2.1.235.patched",
    tlsConfig: { cert: "cert", key: "key" },
    listenerTls: "wss",
    strategyId: "host-check-ipv6-loopback-v1",
    version: "2.1.235",
    sourcePath: "/usr/local/bin/claude",
  });

  /** A claude old enough to need no patch at all — plain ws, no TLS. */
  const unpatchedResolution = (): ClaudeResolution => ({
    binaryPath: "/usr/local/bin/claude",
    tlsConfig: null,
    listenerTls: "plain-ws",
    strategyId: "noop-pre-2.1.120",
    version: "2.1.119",
    sourcePath: "/usr/local/bin/claude",
  });

  // Real material, because a wss listener has to actually bind. Generated once
  // for the file (openssl keygen is the expensive part) and cached by dir.
  let tlsMaterial: { cert: string; key: string } | undefined;
  function tls(): { cert: string; key: string } {
    if (!tlsMaterial) {
      const { cert, key } = ensureSelfSignedCert({ dir: mkdtempSync(join(tmpdir(), "worker-refresh-tls-")) });
      tlsMaterial = { cert, key };
    }
    return tlsMaterial;
  }

  /**
   * A daemon that came up on a stale patch: refusing spawns, but already bound
   * for the wss:// endpoint a refreshed patched binary will need.
   */
  function disabledServer(spawn: SpawnFn): ClaudeWsServer {
    return new ClaudeWsServer({
      spawn,
      logger: silentLogger,
      binaryPath: "/store/2.1.234.patched",
      spawnDisabledReason: STALE_REASON,
      claudeVersion: "2.1.235",
      defaultTransport: "stdio",
      tlsConfig: tls(),
    });
  }

  const NO_VERSION_REASON = "Could not determine claude version: exit 137";

  /**
   * A daemon that came up without ever learning the version — so it bound
   * plain ws, because nothing said otherwise. The listener it has and the
   * listener a patched claude needs are now free to disagree (#3289 review).
   */
  function unknownVersionServer(spawn: SpawnFn): ClaudeWsServer {
    return new ClaudeWsServer({
      spawn,
      logger: silentLogger,
      spawnDisabledReason: NO_VERSION_REASON,
      claudeVersion: null,
      defaultTransport: "ws",
    });
  }

  test("a healthy server is never re-probed — no subprocess on the happy path", async () => {
    server = new ClaudeWsServer({ spawn: makeRecordingSpawn().spawn, logger: silentLogger });
    let probes = 0;
    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => {
        probes++;
        return freshResolution();
      },
    });
    expect(probes).toBe(0);
    expect(server.spawnDisabled).toBe(false);
  });

  test("a successful patch-update unblocks spawn without a daemon restart", async () => {
    const recording = makeRecordingSpawn();
    server = disabledServer(recording.spawn);
    await server.start();
    expect(server.spawnDisabled).toBe(true);

    // Stands in for `mcx claude patch-update` having refreshed the on-disk
    // store from the CLI process since this worker started.
    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => freshResolution(),
      readTransportPref: () => undefined,
    });
    expect(server.spawnDisabled).toBe(false);

    // The next spawn goes through, and goes to the NEW binary. handlePrompt
    // re-enters the refresh with the real resolver, which short-circuits now
    // that spawning is enabled — so no `claude --version` runs here.
    (globalThis as Record<string, unknown>).postMessage = () => {};
    await handlePrompt(server, { prompt: "hello", cwd: "/tmp/wt" });
    expect(recording.lastCmd()[0]).toBe("/store/2.1.235.patched");
  });

  test("spawn stays refused, with the original message, when the re-probe still fails", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    await server.start();

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => staleResolution(),
      readTransportPref: () => undefined,
    });
    expect(server.spawnDisabled).toBe(true);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi" });
    expect(() => server?.spawnClaude(sessionId)).toThrow(/patch-update/);
  });

  test("a probe that throws leaves the actionable reason in place", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    await server.start();
    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => {
        throw new Error("ETXTBSY");
      },
    });
    expect(server.spawnDisabled).toBe(true);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi" });
    expect(() => server?.spawnClaude(sessionId)).toThrow(/patch-update/);
  });

  test("a burst of blocked spawns shares one probe", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    let probes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolve = async () => {
      probes++;
      await gate;
      return freshResolution();
    };
    const all = Promise.all([
      refreshClaudeResolutionIfDisabled(server, { resolve, readTransportPref: () => undefined }),
      refreshClaudeResolutionIfDisabled(server, { resolve, readTransportPref: () => undefined }),
      refreshClaudeResolutionIfDisabled(server, { resolve, readTransportPref: () => undefined }),
    ]);
    release();
    await all;
    expect(probes).toBe(1);
    expect(server.spawnDisabled).toBe(false);
  });

  test("a refresh that resolves no binary keeps the path sessions already use", async () => {
    const recording = makeRecordingSpawn();
    server = disabledServer(recording.spawn);
    await server.start();

    server.applySpawnResolution({
      binaryPath: null,
      spawnDisabledReason: null,
      claudeVersion: "2.1.235",
      defaultTransport: "stdio",
      listenerTls: "wss",
    });

    (globalThis as Record<string, unknown>).postMessage = () => {};
    await handlePrompt(server, { prompt: "hello", cwd: "/tmp/wt" });
    expect(recording.lastCmd()[0]).toBe("/store/2.1.234.patched");
  });

  // ── The refreshed binary and the bound listener must agree (#3289 review) ──
  //
  // `Bun.serve` fixes its TLS mode at bind time, so a resolution taken later
  // can want a scheme the live listener does not speak. claude fails *silently*
  // on the wrong one — the patched binary's host allowlist just refuses to
  // connect — so these assert on the `--sdk-url` actually handed to the child,
  // not merely on which binary was chosen.

  test("a wss listener adopting a refreshed patched binary keeps the wss:// sdk-url", async () => {
    const recording = makeRecordingSpawn();
    server = disabledServer(recording.spawn);
    const port = await server.start();

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => freshResolution(),
      readTransportPref: () => undefined,
    });
    expect(server.spawnDisabled).toBe(false);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "ws" });
    server.spawnClaude(sessionId);
    expect(recording.lastCmd()[0]).toBe("/store/2.1.235.patched");
    expect(recording.lastCmd()).toContain(`wss://[::1]:${port}/session/${sessionId}`);
  });

  test("a plain-ws listener refuses a refreshed PATCHED binary instead of handing it a ws:// sdk-url", async () => {
    // The regression this guards: the worker started before the version was
    // known, so it bound plain ws. A patched claude handed `ws://localhost`
    // never connects and never says why — an honest refusal naming `mcx daemon
    // restart` is the only correct outcome, since the listener cannot be
    // re-bound underneath the sessions it is serving.
    const recording = makeRecordingSpawn();
    server = unknownVersionServer(recording.spawn);
    await server.start();

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => freshResolution(),
      readTransportPref: () => undefined,
    });

    expect(server.spawnDisabled).toBe(true);
    expect(server.spawnResolution.spawnDisabledReason).toMatch(/mcx daemon restart/);
    expect(server.spawnResolution.binaryPath).not.toBe("/store/2.1.235.patched");
    // The version IS adopted — it is a fact about the host, and the
    // `--permission-mode auto` gate (#3119) reads it.
    expect(server.spawnResolution.claudeVersion).toBe("2.1.235");

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "ws" });
    expect(() => server?.spawnClaude(sessionId)).toThrow(/mcx daemon restart/);
    expect(recording.lastCmd()).toEqual([]);
  });

  test("a plain-ws listener DOES adopt a refreshed unpatched binary, and the sdk-url stays ws://", async () => {
    // Same starting point, but the refresh finds a claude old enough to need no
    // patch. Nothing disagrees, so this must self-heal like any other refresh.
    const recording = makeRecordingSpawn();
    server = unknownVersionServer(recording.spawn);
    const port = await server.start();

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => unpatchedResolution(),
      readTransportPref: () => "sdk-url",
    });
    expect(server.spawnDisabled).toBe(false);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "ws" });
    server.spawnClaude(sessionId);
    expect(recording.lastCmd()[0]).toBe("/usr/local/bin/claude");
    expect(recording.lastCmd()).toContain(`ws://localhost:${port}/session/${sessionId}`);
  });

  test("a wss listener refuses a refreshed binary that wants plain ws", async () => {
    // The mirror case — claude was downgraded below 2.1.120 under a daemon
    // bound for wss. Also unserveable, also fixed by a restart.
    server = disabledServer(makeRecordingSpawn().spawn);
    await server.start();

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => unpatchedResolution(),
      readTransportPref: () => undefined,
    });

    expect(server.spawnDisabled).toBe(true);
    expect(server.spawnResolution.spawnDisabledReason).toMatch(/mcx daemon restart/);
    expect(server.spawnResolution.binaryPath).toBe("/store/2.1.234.patched");
  });

  test("the revive path is refused too when the refreshed claude needs the other scheme", async () => {
    // reviveSession respawns a child, so it is stranded by exactly the same
    // mismatch as a fresh spawn — and a session pinned to `ws` would otherwise
    // be revived straight onto the unserveable binary.
    const recording = makeRecordingSpawn();
    server = unknownVersionServer(recording.spawn);
    await server.start();
    server.restoreSessions([
      {
        sessionId: "revive-mismatch-1",
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

    (globalThis as Record<string, unknown>).postMessage = () => {};
    const result = await handlePrompt(
      server,
      { sessionId: "revive-mismatch-1", prompt: "continue" },
      undefined,
      // Same probe the spawn path takes; here it resolves a patched binary the
      // plain-ws listener cannot serve.
      { resolve: async () => freshResolution(), readTransportPref: () => undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/mcx daemon restart/);
    expect(recording.lastCmd()).toEqual([]);
  });

  // ── A refresh that learned nothing must change nothing (#3289 review) ──

  test("a re-probe that cannot determine a version leaves every field alone", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    const before = server.spawnResolution;

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => ({
        error: NO_VERSION_REASON,
        reason: "version-probe-failed",
        version: null,
        tlsConfig: null,
        listenerTls: "unknown",
      }),
      readTransportPref: () => undefined,
    });

    // Not just "still disabled": a transient probe failure under load must not
    // downgrade the actionable patch-update message to generic transport noise,
    // blank the known version, or flip defaultTransport back to "ws".
    expect(server.spawnResolution).toEqual(before);
  });

  test("a re-probe that DID determine a version replaces the reason with the new one", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);

    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => ({
        error: "claude 9.9.9 is not supported by any registered patch strategy.",
        reason: "unsupported-version",
        version: "9.9.9",
        tlsConfig: null,
        listenerTls: "unknown",
      }),
      readTransportPref: () => undefined,
    });

    expect(server.spawnResolution.spawnDisabledReason).toMatch(/not supported/);
    expect(server.spawnResolution.claudeVersion).toBe("9.9.9");
  });

  // ── Backoff (#3289 review) ──

  test("a repeatedly failing re-probe backs off instead of probing on every spawn", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    let probes = 0;
    let clock = 0;
    const attempt = () =>
      refreshClaudeResolutionIfDisabled(server as ClaudeWsServer, {
        resolve: async () => {
          probes++;
          return staleResolution();
        },
        readTransportPref: () => undefined,
        now: () => clock,
      });

    await attempt();
    expect(probes).toBe(1);

    // The whole point: a broken patch store must not cost a `claude --version`
    // per spawn attempt on the thread serving live sessions.
    clock = 500;
    await attempt();
    expect(probes).toBe(1);

    clock = 1_000;
    await attempt();
    expect(probes).toBe(2);

    // Second failure doubles the window, so the same 1s gap is now too soon.
    clock = 2_000;
    await attempt();
    expect(probes).toBe(2);

    clock = 3_000;
    await attempt();
    expect(probes).toBe(3);
  });

  test("backoff never delays the fix — a successful refresh clears it", async () => {
    server = disabledServer(makeRecordingSpawn().spawn);
    let clock = 0;
    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => staleResolution(),
      readTransportPref: () => undefined,
      now: () => clock,
    });
    expect(server.spawnDisabled).toBe(true);

    clock = 1_000;
    await refreshClaudeResolutionIfDisabled(server, {
      resolve: async () => freshResolution(),
      readTransportPref: () => undefined,
      now: () => clock,
    });
    expect(server.spawnDisabled).toBe(false);
    expect(server.spawnResolution.binaryPath).toBe("/store/2.1.235.patched");
  });
});
