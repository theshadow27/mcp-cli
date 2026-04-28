import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@mcp-cli/core";
import { ensureSelfSignedCert } from "../tls/self-signed";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

// ── Mock spawn (lifted from ws-server.spec.ts to keep this file standalone) ──

function mockSpawn(): {
  spawn: SpawnFn;
  killed: boolean;
  lastCmd: string[];
  lastOpts: { cwd?: string; env?: Record<string, string | undefined> };
} {
  let exitResolve: (code: number) => void = () => {};
  const state = {
    spawn: ((cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => {
      state.lastCmd = cmd;
      state.lastOpts = { cwd: opts?.cwd, env: opts?.env };
      return {
        pid: 12345,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          state.killed = true;
          exitResolve(143);
        },
      };
    }) as SpawnFn,
    killed: false,
    lastCmd: [] as string[],
    lastOpts: {} as { cwd?: string; env?: Record<string, string | undefined> },
  };
  return state;
}

describe("ClaudeWsServer (TLS mode, #1808)", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("isTls reports false in plain ws:// mode", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    expect(server.isTls).toBe(false);
  });

  test("isTls reports true when tlsConfig is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-tls-"));
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 7 });
    server = new ClaudeWsServer({
      spawn: mockSpawn().spawn,
      logger: silentLogger,
      tlsConfig: { cert, key },
    });
    expect(server.isTls).toBe(true);
  });

  test("plain mode emits ws:// sdk-url and no NODE_TLS_REJECT_UNAUTHORIZED in env", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();
    server.prepareSession("plain-session", { prompt: "hi" });
    server.spawnClaude("plain-session");

    expect(ms.lastCmd).toContain(`ws://localhost:${port}/session/plain-session`);
    expect(ms.lastCmd.some((s) => s.startsWith("wss://"))).toBe(false);
    // Env may be undefined or present without our override.
    const env = ms.lastOpts.env ?? {};
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  test("TLS mode emits wss://[::1] sdk-url and sets NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-tls-"));
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 7 });
    const ms = mockSpawn();
    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: silentLogger,
      tlsConfig: { cert, key },
    });
    const port = await server.start();
    server.prepareSession("tls-session", { prompt: "hi" });
    server.spawnClaude("tls-session");

    expect(ms.lastCmd).toContain(`wss://[::1]:${port}/session/tls-session`);
    expect(ms.lastCmd.some((s) => s === `ws://localhost:${port}/session/tls-session`)).toBe(false);
    const env = ms.lastOpts.env ?? {};
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
  });

  test("TLS mode binds on [::1] and accepts a wss:// upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-tls-"));
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 7 });
    server = new ClaudeWsServer({
      spawn: mockSpawn().spawn,
      logger: silentLogger,
      tlsConfig: { cert, key },
    });
    const port = await server.start();

    // Register a session so the server's path-routing matches.
    server.prepareSession("conn-test", { prompt: "hi" });

    // Subprocess client trusts the cert via NODE_TLS_REJECT_UNAUTHORIZED=0.
    // Mid-process env mutation is not load-bearing for the Bun WS client in
    // every code path, so a subprocess gives a deterministic check.
    const url = `wss://[::1]:${port}/session/conn-test`;
    const scriptPath = join(dir, "client.ts");
    writeFileSync(
      scriptPath,
      `const ws = new WebSocket(${JSON.stringify(url)});
const deadline = Date.now() + 4000;
while (Date.now() < deadline && ws.readyState === WebSocket.CONNECTING) {
  await Bun.sleep(20);
}
if (ws.readyState !== WebSocket.OPEN) {
  process.stderr.write('readyState=' + ws.readyState + '\\n');
  process.exit(1);
}
ws.close();
process.stdout.write('OK');
`,
    );
    const proc = Bun.spawn({
      cmd: ["bun", scriptPath],
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("TLS mode rejects plain ws:// upgrade attempts", async () => {
    // Sanity: a plain ws client cannot connect to a TLS server. Keeps the
    // expectation explicit so a misconfigured deployment fails loud.
    const dir = mkdtempSync(join(tmpdir(), "ws-tls-"));
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 7 });
    server = new ClaudeWsServer({
      spawn: mockSpawn().spawn,
      logger: silentLogger,
      tlsConfig: { cert, key },
    });
    const port = await server.start();
    server.prepareSession("plain-fail", { prompt: "hi" });

    const url = `ws://[::1]:${port}/session/plain-fail`;
    const scriptPath = join(dir, "client-plain.ts");
    writeFileSync(
      scriptPath,
      `const ws = new WebSocket(${JSON.stringify(url)});
const deadline = Date.now() + 2500;
while (Date.now() < deadline && ws.readyState === WebSocket.CONNECTING) {
  await Bun.sleep(20);
}
process.stdout.write('readyState=' + ws.readyState);
`,
    );
    const proc = Bun.spawn({
      cmd: ["bun", scriptPath],
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // Either CLOSED(3) on rejection or stuck CONNECTING(0) past the deadline.
    expect(stdout).not.toContain("readyState=1");
  });

  test("custom binaryPath is used in the spawn command", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: silentLogger,
      binaryPath: "/opt/custom/claude.patched",
    });
    await server.start();
    server.prepareSession("bin-session", { prompt: "hi" });
    server.spawnClaude("bin-session");
    expect(ms.lastCmd[0]).toBe("/opt/custom/claude.patched");
    expect(ms.lastCmd).not.toContain("claude");
  });

  test("default binaryPath is 'claude' when not overridden", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();
    server.prepareSession("default-session", { prompt: "hi" });
    server.spawnClaude("default-session");
    expect(ms.lastCmd[0]).toBe("claude");
  });

  test("spawnDisabledReason → spawnClaude throws with that reason and never invokes spawn", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({
      spawn: ms.spawn,
      logger: silentLogger,
      spawnDisabledReason: "claude 9.9.9 is not supported by any registered patch strategy.",
    });
    await server.start();
    server.prepareSession("blocked-session", { prompt: "hi" });
    expect(() => server?.spawnClaude("blocked-session")).toThrow(/9\.9\.9/);
    // spawn was never called: ms.lastCmd remains the initial empty array.
    expect(ms.lastCmd).toEqual([]);
  });
});
