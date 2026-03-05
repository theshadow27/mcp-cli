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
import { join } from "node:path";
import type { TestDaemon } from "./harness";
import { echoServerConfig, rpc, startTestDaemon } from "./harness";

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

  test("idle timeout fires and process exits", async () => {
    daemon = await startTestDaemon({}, { idleTimeout: 1_000 });

    // Daemon should exit within ~2s of starting (1s idle + margin)
    const exitCode = await Promise.race([daemon.proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    expect(exitCode).toBe(0);
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
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: {} }));
    const proc2 = Bun.spawn(["bun", "packages/daemon/src/index.ts"], {
      stdout: "ignore",
      stderr: "pipe",
      cwd: process.cwd(),
      env: { ...process.env, MCP_CLI_DIR: daemon.dir, MCP_DAEMON_TIMEOUT: "30000" },
    });

    // Poll socket + ping to detect readiness (avoids stdout pipe buffering issues)
    const socketPath = join(daemon.dir, "mcpd.sock");
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      const exited = await Promise.race([proc2.exited.then(() => true), Bun.sleep(50).then(() => false)]);
      if (exited) break;
      if (!existsSync(socketPath)) continue;
      try {
        const res = await rpc(socketPath, "ping");
        if (res.result && (res.result as { pong?: boolean }).pong) {
          ready = true;
          break;
        }
      } catch {
        await Bun.sleep(50);
      }
    }

    expect(ready).toBe(true);

    // New daemon responds to ping
    const res = await rpc(socketPath, "ping");
    expect(res.result).toHaveProperty("pong", true);

    proc2.kill("SIGTERM");
    await proc2.exited;
    daemon = undefined;
  });
});

// ---------------------------------------------------------------------------
// P2: Config hot reload
// ---------------------------------------------------------------------------
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

    // Initially no servers
    const before = await rpc(daemon.socketPath, "listServers");
    expect(before.result).toEqual([]);

    // Write echo server config
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: { echo: echoServerConfig() } }));

    // Wait for debounce (300ms) + processing
    await Bun.sleep(800);

    const after = await rpc(daemon.socketPath, "listServers");
    const servers = after.result as Array<{ name: string }>;
    expect(servers.some((s) => s.name === "echo")).toBe(true);
  });

  test("removing a server from config is detected", async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });

    // Server should be present
    const before = await rpc(daemon.socketPath, "listServers");
    expect((before.result as Array<{ name: string }>).some((s) => s.name === "echo")).toBe(true);

    // Remove all servers
    writeFileSync(join(daemon.dir, "servers.json"), JSON.stringify({ mcpServers: {} }));

    await Bun.sleep(800);

    const after = await rpc(daemon.socketPath, "listServers");
    expect(after.result).toEqual([]);
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
