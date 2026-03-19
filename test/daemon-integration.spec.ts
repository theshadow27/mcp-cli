/**
 * Daemon integration tests — exercises the full daemon lifecycle,
 * config hot reload, multi-transport, concurrency, and error paths.
 *
 * Each test group runs in an isolated temp directory via MCP_CLI_DIR.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// CI runners are slower — give daemon spawn + test logic plenty of room
setDefaultTimeout(30_000);
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestDaemon } from "./harness";
import { echoServerConfig, pollUntil, rpc, startTestDaemon } from "./harness";

// ---------------------------------------------------------------------------
// P1: Daemon lifecycle
// ---------------------------------------------------------------------------
describe("P1: Daemon lifecycle", () => {
  let daemon: TestDaemon | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.kill();
      daemon = undefined;
    }
  });

  test("daemon starts and responds to ping", async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
    const res = await rpc(daemon.socketPath, "ping");
    expect(res.error).toBeUndefined();
    expect(res.result).toHaveProperty("pong", true);
    expect(res.result).toHaveProperty("time");
  });

  test("shutdown via IPC exits cleanly", async () => {
    daemon = await startTestDaemon({});
    const res = await rpc(daemon.socketPath, "shutdown");
    expect(res.result).toEqual({ ok: true });

    const exitCode = await daemon.proc.exited;
    expect(exitCode).toBe(0);

    // PID file should be cleaned up
    expect(existsSync(join(daemon.dir, "mcpd.pid"))).toBe(false);
    // Prevent double-kill in afterEach
    daemon = undefined;
  });

  test("shutdown via IPC logs reason in stderr", async () => {
    daemon = await startTestDaemon({});
    await rpc(daemon.socketPath, "shutdown");
    await daemon.proc.exited;

    const stderr = await new Response(daemon.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("Shutting down (IPC shutdown request)");
    daemon = undefined;
  });

  test("shutdown via SIGTERM logs reason in stderr", async () => {
    daemon = await startTestDaemon({});
    daemon.proc.kill("SIGTERM");
    await daemon.proc.exited;

    const stderr = await new Response(daemon.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("Shutting down (SIGTERM)");
    daemon = undefined;
  });

  test("idle timeout fires and process exits", async () => {
    // Skip virtual servers — their variable startup time defers the idle timer
    // via hasPendingServers(), which was the root cause of the 15s margin (#492).
    daemon = await startTestDaemon({}, { idleTimeout: 4_000, skipVirtualServers: true });

    // Margin-based workaround: 4s idle + 6s margin = 10s deadline.
    // Under CPU contention setTimeout can fire late — see #842 for root cause investigation.
    const t0 = Date.now();
    const exitCode = await Promise.race([daemon.proc.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
    const elapsed = Date.now() - t0;

    if (exitCode === "timeout") {
      console.error(
        `[idle-timeout-test] timed out after ${elapsed}ms, pid ${daemon.proc.pid} killed=${daemon.proc.killed}`,
      );
    }
    expect(exitCode).toBe(0);

    // Daemon should exit within 2x its configured idle timeout under any reasonable load
    if (exitCode === 0) expect(elapsed).toBeLessThan(8_000);

    daemon = undefined;
  });

  test("stale PID file is overwritten on start", async () => {
    // Start a daemon, then kill it without clean shutdown to leave stale PID
    daemon = await startTestDaemon({});
    const pidPath = join(daemon.dir, "mcpd.pid");
    expect(existsSync(pidPath)).toBe(true);

    // Force kill (no clean shutdown → PID file remains)
    daemon.proc.kill("SIGKILL");
    await daemon.proc.exited;
    expect(existsSync(pidPath)).toBe(true);

    // Start a new daemon in the same directory — it should overwrite the stale PID
    const daemon2 = await startTestDaemon({}, { dir: daemon.dir });

    // New daemon responds to ping
    const res = await rpc(daemon2.socketPath, "ping");
    expect(res.result).toHaveProperty("pong", true);

    await daemon2.kill();
    daemon = undefined;
  });
});

// ---------------------------------------------------------------------------
// P2: Config hot reload
// ---------------------------------------------------------------------------
// Polling fallback makes config detection reliable on all platforms — see #313
describe("P2: Config hot reload", () => {
  let daemon: TestDaemon | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.kill();
      daemon = undefined;
    }
  });

  test("adding a server to config is detected", async () => {
    daemon = await startTestDaemon({});

    // Initially only virtual servers (_aliases, _claude)
    const before = await rpc(daemon.socketPath, "listServers");
    const beforeServers = before.result as Array<{ name: string }>;
    expect(beforeServers.some((s) => s.name === "_aliases")).toBe(true);
    expect(beforeServers.some((s) => s.name === "_claude")).toBe(true);
    expect(beforeServers.every((s) => s.name.startsWith("_"))).toBe(true);

    // Write echo server config
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: { echo: echoServerConfig() } }));

    // Poll with async predicate — exits as soon as condition is met
    const sock = daemon.socketPath;
    await pollUntil(async () => {
      const after = await rpc(sock, "listServers");
      const servers = after.result as Array<{ name: string }>;
      return servers.some((s) => s.name === "echo");
    }, 10_000);
  });

  test("modifying a server config triggers reconnect", async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });

    // Connect the echo server by calling a tool
    const before = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "echo",
      arguments: { message: "before" },
    });
    expect(before.error).toBeUndefined();

    // Verify it's connected
    const statusBefore = await rpc(daemon.socketPath, "listServers");
    const echoBefore = (statusBefore.result as Array<{ name: string; state: string }>).find((s) => s.name === "echo");
    expect(echoBefore?.state).toBe("connected");

    // Modify the echo server config (add an env var — changes deepEquals comparison)
    const modifiedConfig = { ...echoServerConfig(), env: { MODIFIED: "1" } };
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: { echo: modifiedConfig } }));

    // Poll until the server has been through a reconnect cycle.
    // After config change, connected servers go through disconnect → reconnect.
    // We detect this by waiting for the server to return to connected state
    // with valid tools (meaning the new process started successfully).
    const sock = daemon.socketPath;
    await pollUntil(async () => {
      const res = await rpc(sock, "listServers");
      const echo = (res.result as Array<{ name: string; state: string }>).find((s) => s.name === "echo");
      // During reconnect, state may briefly be disconnected/connecting.
      // We want to see it come back to connected.
      return echo?.state === "connected";
    }, 10_000);

    // Confirm the reconnected server still works
    const after = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "echo",
      arguments: { message: "after reconnect" },
    });
    expect(after.error).toBeUndefined();
    const content = (after.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe("after reconnect");
  });

  test("removing a server from config is detected", async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });

    // Server should be present
    const before = await rpc(daemon.socketPath, "listServers");
    expect((before.result as Array<{ name: string }>).some((s) => s.name === "echo")).toBe(true);

    // Remove all servers
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: {} }));

    // Poll with async predicate — exits as soon as condition is met
    const sock = daemon.socketPath;
    await pollUntil(async () => {
      const after = await rpc(sock, "listServers");
      const afterServers = after.result as Array<{ name: string }>;
      return afterServers.every((s) => s.name.startsWith("_"));
    }, 10_000);
  });
});

// ---------------------------------------------------------------------------
// P3: Stdio transport end-to-end (through daemon)
// ---------------------------------------------------------------------------
describe("P3: Stdio transport end-to-end", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("listTools returns echo server tools", async () => {
    const res = await rpc(daemon.socketPath, "listTools", { server: "echo" });
    expect(res.error).toBeUndefined();
    const tools = res.result as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "echo", "fail"]);
  });

  test("callTool echo returns correct result", async () => {
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "echo",
      arguments: { message: "hello world" },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe("hello world");
  });

  test("callTool add returns correct sum", async () => {
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "add",
      arguments: { a: 17, b: 25 },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe("42");
  });

  test("callTool fail returns error content without crashing daemon", async () => {
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "fail",
      arguments: {},
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("intentional failure");

    // Daemon should still be alive
    const ping = await rpc(daemon.socketPath, "ping");
    expect(ping.result).toHaveProperty("pong", true);
  });
});

// ---------------------------------------------------------------------------
// P4: Concurrent operations
// ---------------------------------------------------------------------------
describe("P4: Concurrent operations", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("parallel callTool requests return correct isolated results", async () => {
    const count = 10;
    const promises = Array.from({ length: count }, (_, i) =>
      rpc(daemon.socketPath, "callTool", {
        server: "echo",
        tool: "add",
        arguments: { a: i, b: 100 },
      }),
    );

    const results = await Promise.all(promises);
    for (let i = 0; i < count; i++) {
      expect(results[i].error).toBeUndefined();
      const content = (results[i].result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(String(i + 100));
    }
  });

  test("callTool during config reload does not crash", async () => {
    // Fire a config write while simultaneously calling tools — daemon must not crash
    const echoConfig = echoServerConfig();
    const configPath = join(daemon.dir, "servers.json");

    // Add a second server to trigger config reload
    writeFileSync(configPath, JSON.stringify({ mcpServers: { echo: echoConfig, echo2: echoConfig } }));

    // Immediately fire parallel callTool requests on the existing echo server
    const count = 5;
    const promises = Array.from({ length: count }, (_, i) =>
      rpc(daemon.socketPath, "callTool", {
        server: "echo",
        tool: "add",
        arguments: { a: i, b: 200 },
      }),
    );

    const results = await Promise.all(promises);
    for (let i = 0; i < count; i++) {
      expect(results[i].error).toBeUndefined();
      const content = (results[i].result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(String(i + 200));
    }

    // Daemon should still respond after the reload storm
    const ping = await rpc(daemon.socketPath, "ping");
    expect(ping.result).toHaveProperty("pong", true);

    // Wait for echo2 to appear, confirming reload completed
    const sock = daemon.socketPath;
    await pollUntil(async () => {
      const res = await rpc(sock, "listServers");
      return (res.result as Array<{ name: string }>).some((s) => s.name === "echo2");
    }, 10_000);

    // Restore original config for subsequent tests
    writeFileSync(configPath, JSON.stringify({ mcpServers: { echo: echoConfig } }));
  });

  test("listServers shows server in non-connected state before first use", async () => {
    // Add a server that will fail to connect (invalid command)
    const configPath = join(daemon.dir, "servers.json");
    const echoConfig = echoServerConfig();
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          echo: echoConfig,
          broken: { command: "nonexistent-binary-that-does-not-exist-12345" },
        },
      }),
    );

    // Poll until the broken server appears in listServers
    const sock = daemon.socketPath;
    await pollUntil(async () => {
      const res = await rpc(sock, "listServers");
      return (res.result as Array<{ name: string }>).some((s) => s.name === "broken");
    }, 10_000);

    // Server should be in disconnected state (lazy connect — not attempted yet)
    const res = await rpc(daemon.socketPath, "listServers");
    const servers = res.result as Array<{ name: string; state: string }>;
    const broken = servers.find((s) => s.name === "broken");
    expect(broken).toBeDefined();
    expect(broken?.state).toBe("disconnected");

    // Restore original config
    writeFileSync(configPath, JSON.stringify({ mcpServers: { echo: echoConfig } }));

    // Wait for broken server to be removed
    await pollUntil(async () => {
      const after = await rpc(sock, "listServers");
      return (after.result as Array<{ name: string }>).every((s) => s.name !== "broken");
    }, 10_000);
  });
});

// ---------------------------------------------------------------------------
// P5: Error scenarios
// ---------------------------------------------------------------------------
describe("P5: Error scenarios", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("callTool to non-existent server returns error", async () => {
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "nonexistent",
      tool: "echo",
      arguments: { message: "test" },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain("nonexistent");
  });

  test("callTool to non-existent tool returns error", async () => {
    // First connect echo server by listing tools
    await rpc(daemon.socketPath, "listTools", { server: "echo" });

    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "nonexistent_tool",
      arguments: {},
    });
    expect(res.error).toBeDefined();
  });

  test("daemon survives error and continues responding", async () => {
    // Trigger the fail tool
    await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "fail",
      arguments: {},
    });

    // Try calling a non-existent server
    await rpc(daemon.socketPath, "callTool", {
      server: "ghost",
      tool: "anything",
      arguments: {},
    });

    // Daemon should still be perfectly functional
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "echo",
      arguments: { message: "still alive" },
    });
    expect(res.error).toBeUndefined();
    const content = (res.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe("still alive");
  });
});

// ---------------------------------------------------------------------------
// P5b: Error scenario edge cases (#117)
// ---------------------------------------------------------------------------
describe("P5b: Error scenario edge cases", () => {
  let daemon: TestDaemon | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.kill();
      daemon = undefined;
    }
  });

  test("HTTP 401 error suggests 'mcx auth' in the error message", async () => {
    // Start a local HTTP server that always returns 401
    const authServer = Bun.spawn(["bun", resolve("test/http-401-server.ts")], {
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      // Read the port from stdout
      const reader = authServer.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const port = Number(new TextDecoder().decode(value).trim());

      daemon = await startTestDaemon({
        authfail: { type: "http", url: `http://127.0.0.1:${port}/mcp` },
      });

      // Trigger a connection attempt — the 401 should produce an auth hint
      const res = await rpc(daemon.socketPath, "listTools", { server: "authfail" });
      expect(res.error).toBeDefined();
      expect(res.error?.message).toContain("auth");
      expect(res.error?.message).toContain("mcx auth");

      // Verify lastError also contains the hint
      const list = await rpc(daemon.socketPath, "listServers");
      const server = (list.result as Array<{ name: string; lastError?: string }>).find((s) => s.name === "authfail");
      expect(server?.lastError).toContain("mcx auth");
    } finally {
      authServer.kill();
      await authServer.exited;
    }
  });

  test("callTool with short timeout returns clear timeout error", async () => {
    daemon = await startTestDaemon({
      slow: {
        command: "bun",
        args: [resolve("test/slow-echo-server.ts")],
        env: { SLOW_MS: "10000" },
      },
    });

    // Ensure server is connected first
    const tools = await rpc(daemon.socketPath, "listTools", { server: "slow" });
    expect(tools.error).toBeUndefined();

    // Call with an impossibly short timeout (100ms vs 10s delay)
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "slow",
      tool: "slow_echo",
      arguments: { message: "should timeout" },
      timeoutMs: 100,
    });
    expect(res.error).toBeDefined();
    // The error should mention timeout or timed out
    const msg = res.error?.message?.toLowerCase() ?? "";
    expect(msg.includes("timed out") || msg.includes("timeout")).toBe(true);
  });

  test("server that fails to start produces actionable error via callTool", async () => {
    daemon = await startTestDaemon({
      crasher: { command: "bun", args: [resolve("test/exit-immediately.ts")] },
    });

    // callTool against a server that crashes on startup
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "crasher",
      tool: "anything",
      arguments: {},
    });
    expect(res.error).toBeDefined();
    // Error should identify the server by name
    expect(res.error?.message).toContain("crasher");

    // Daemon should still be alive after the error
    const ping = await rpc(daemon.socketPath, "ping");
    expect(ping.result).toHaveProperty("pong", true);
  });
});
