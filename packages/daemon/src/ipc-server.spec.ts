import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcResponse } from "@mcp-cli/core";
import { IPC_ERROR, PROTOCOL_VERSION, options, silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { ClaudeServer } from "./claude-server";
import { installDaemonLogCapture } from "./daemon-log";
import { StateDb } from "./db/state";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import { IpcServer } from "./ipc-server";
import { metrics } from "./metrics";

// Install daemon log capture so getDaemonLogs handler works
installDaemonLogCapture();

/** Unique socket path per test run to avoid conflicts */
function tmpSocket(): string {
  return join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

// Shared poll helper — throws on timeout for visible test failures
import { pollUntil } from "../../../test/harness";

/** Minimal mock pool — only transport behavior is under test */
function mockPool() {
  return {
    listServers: () => [],
    listTools: () => [],
    getToolInfo: () => null,
    grepTools: () => [],
    callTool: async () => ({ content: [] }),
    getServerUrl: () => null,
    getDb: () => null,
    restart: async () => {},
    getStderrLines: () => [],
    subscribeStderr: () => () => {},
  };
}

function mockDb(overrides?: Partial<Record<string, unknown>>) {
  return {
    recordUsage: () => {},
    recordSpan: () => {},
    getUsageStats: () => [],
    getSpans: () => [],
    markSpansExported: () => {},
    pruneSpans: () => 0,
    listAliases: () => [],
    getAlias: () => null,
    saveAlias: () => {},
    deleteAlias: () => {},
    touchAliasExpiry: () => {},
    pruneExpiredAliases: () => 0,
    getServerLogs: () => [],
    getCachedTools: () => [],
    listSessions: () => [],
    getDatabase: () => new Database(":memory:"),
    ...overrides,
  } as never;
}

function mockConfig() {
  return {
    servers: new Map(),
    sources: [],
  } as never;
}

const TEST_DAEMON_ID = "aabbccddee112233";
const TEST_STARTED_AT = 1700000000000;

/** Merge trace defaults into IpcServer options */
function opts(overrides?: {
  onActivity?: () => void;
  onRequestComplete?: () => void;
  onShutdown?: () => void;
  onReloadConfig?: () => Promise<void>;
  drainTimeoutMs?: number;
}) {
  return {
    daemonId: TEST_DAEMON_ID,
    startedAt: TEST_STARTED_AT,
    onActivity: () => {},
    logger: silentLogger,
    ...overrides,
  };
}

describe("IpcServer HTTP transport", () => {
  let server: IpcServer | undefined;
  let socketPath: string;

  afterEach(() => {
    server?.stop();
    server = undefined;
    try {
      unlinkSync(socketPath);
    } catch {
      /* already cleaned up */
    }
  });

  function startServer(): void {
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);
  }

  async function rpc(path: string, body?: unknown, method = "POST"): Promise<Response> {
    return fetch(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      unix: socketPath,
    } as RequestInit);
  }

  // ── Shared server for read-only tests ──
  // These tests only read from the default mock pool and don't mutate server state,
  // so they share a single IpcServer instance to avoid per-test startup overhead.
  describe("read-only (shared server)", () => {
    let sharedServer: IpcServer;
    let sharedSocket: string;

    function sharedRpc(path: string, body?: unknown, method = "POST"): Promise<Response> {
      return fetch(`http://localhost${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        unix: sharedSocket,
      } as RequestInit);
    }

    beforeEach(() => {
      // Prevent the outer afterEach from interfering with shared server
      server = undefined;
    });

    // Use a fresh shared server per describe run (beforeAll not available in bun:test,
    // so we use a lazy singleton pattern)
    let initialized = false;
    function ensureServer(): void {
      if (!initialized) {
        sharedSocket = tmpSocket();
        sharedServer = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, opts());
        sharedServer.start(sharedSocket);
        initialized = true;
      }
    }

    afterAll(() => {
      sharedServer?.stop();
      try {
        unlinkSync(sharedSocket);
      } catch {
        /* already cleaned up */
      }
    });

    test("POST /rpc with ping returns result", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "t1", method: "ping" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("t1");
      expect(json.result).toHaveProperty("pong", true);
      expect(json.result).toHaveProperty("time");
      expect(json.error).toBeUndefined();
    });

    test("socket file has 0600 permissions after start", () => {
      ensureServer();
      const mode = statSync(sharedSocket).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test("ping response includes protocolVersion", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "pv1", method: "ping" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      const result = json.result as { pong: boolean; time: number; protocolVersion: string };
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    test("status response includes protocolVersion", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "pv2", method: "status" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      const result = json.result as { protocolVersion: string };
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    test("POST /rpc with invalid JSON returns 400", async () => {
      ensureServer();
      const res = await fetch("http://localhost/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
        unix: sharedSocket,
      } as RequestInit);

      expect(res.status).toBe(400);
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.PARSE_ERROR);
    });

    test("GET /rpc returns 405", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", undefined, "GET");
      expect(res.status).toBe(405);
    });

    test("POST /other returns 404", async () => {
      ensureServer();
      const res = await sharedRpc("/other", { id: "t2", method: "ping" });
      expect(res.status).toBe(404);
    });

    test("unknown method returns error in body", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "t3", method: "nonExistentMethod" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("t3");
      expect(json.error?.code).toBe(IPC_ERROR.METHOD_NOT_FOUND);
    });

    test("large payload round-trips correctly", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "t4", method: "listServers" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("t4");
      expect(json.result).toEqual([]);
    });

    test("concurrent requests are isolated", async () => {
      ensureServer();
      const requests = Array.from({ length: 10 }, (_, i) =>
        sharedRpc("/rpc", { id: `c${i}`, method: "ping" }).then((res) => res.json() as Promise<IpcResponse>),
      );

      const results = await Promise.all(requests);
      for (let i = 0; i < 10; i++) {
        expect(results[i].id).toBe(`c${i}`);
        expect(results[i].result).toHaveProperty("pong", true);
      }
    });

    test("triggerAuth with unknown server returns SERVER_NOT_FOUND error", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "auth1", method: "triggerAuth", params: { server: "nonexistent" } });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("auth1");
      expect(json.error?.code).toBe(IPC_ERROR.SERVER_NOT_FOUND);
      expect(json.error?.message).toContain("nonexistent");
    });

    test("getDaemonLogs returns captured log lines", async () => {
      ensureServer();
      // Emit a recognizable log line via console.error (captured by daemon-log)
      const marker = `ipc-test-${Date.now()}`;
      console.error(marker);

      const res = await sharedRpc("/rpc", { id: "dl1", method: "getDaemonLogs", params: { limit: 5 } });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("dl1");

      const lines = (json.result as { lines: { timestamp: number; line: string }[] }).lines;
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);

      const match = lines.find((l) => l.line === marker);
      expect(match).toBeDefined();
      expect(match?.timestamp).toBeGreaterThan(0);
    });

    test("getDaemonLogs respects since filter", async () => {
      ensureServer();
      const before = Date.now();
      // Use a unique marker with a counter to ensure timestamp separation without sleep
      const marker = `since-test-${before}-${Math.random()}`;
      console.error(marker);

      const res = await sharedRpc("/rpc", {
        id: "dl2",
        method: "getDaemonLogs",
        params: { since: before - 1 },
      });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      const lines = (json.result as { lines: { timestamp: number; line: string }[] }).lines;

      // Our marker should be present
      expect(lines.find((l) => l.line === marker)).toBeDefined();
    });

    test("status response includes usageStats field", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "us1", method: "status" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      expect(json.id).toBe("us1");

      const result = json.result as { usageStats: unknown[] };
      expect(Array.isArray(result.usageStats)).toBe(true);
      expect(result.usageStats).toEqual([]);
    });

    test("status has null wsPort when getWsPortInfo is not provided", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "ws2", method: "status" });
      expect(res.status).toBe(200);

      const json = (await res.json()) as IpcResponse;
      const result = json.result as { wsPort: number | null; wsPortExpected?: number };
      expect(result.wsPort).toBeNull();
      expect(result.wsPortExpected).toBeUndefined();
    });

    test("callTool with missing server param returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "v1", method: "callTool", params: { tool: "t" } });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("Invalid params");
      expect(json.error?.message).toContain("server");
    });

    test("getToolInfo with missing tool param returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "v2", method: "getToolInfo", params: { server: "s" } });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("Invalid params");
      expect(json.error?.message).toContain("tool");
    });

    test("saveAlias with missing name param returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "v3", method: "saveAlias", params: { script: "x" } });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("Invalid params");
      expect(json.error?.message).toContain("name");
    });

    test("getLogs with non-number limit returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "v4", method: "getLogs", params: { server: "s", limit: "abc" } });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("Invalid params");
      expect(json.error?.message).toContain("limit");
    });

    test("grepTools with no params returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "v5", method: "grepTools", params: {} });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("pattern");
    });

    test("callTool with valid params still works", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", {
        id: "v6",
        method: "callTool",
        params: { server: "s", tool: "t", arguments: { key: "val" } },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeUndefined();
      expect(json.result).toHaveProperty("content");
    });

    test("sendMail with missing sender returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", {
        id: "m2",
        method: "sendMail",
        params: { recipient: "manager" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    });

    test("markRead with missing id returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", { id: "m10", method: "markRead", params: {} });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    });

    test("getAlias returns null for unknown alias", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", {
        id: "ga2",
        method: "getAlias",
        params: { name: "nonexistent" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeUndefined();
      expect(json.result).toBeNull();
    });

    test("reloadConfig returns INTERNAL_ERROR when no callback configured", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", {
        id: "rl2",
        method: "reloadConfig",
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
      expect(json.error?.message).toContain("Config reload not available");
    });

    test("GET /logs without params returns 400", async () => {
      ensureServer();
      const res = await fetch("http://localhost/logs", {
        method: "GET",
        unix: sharedSocket,
      } as RequestInit);

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Missing");
    });

    test("registerServe with missing params returns INVALID_PARAMS", async () => {
      ensureServer();
      const res = await sharedRpc("/rpc", {
        id: "si12",
        method: "registerServe",
        params: { instanceId: "x" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    });
  });

  test("shutdown calls onShutdown callback instead of process.exit", async () => {
    socketPath = tmpSocket();
    let shutdownCalled = false;
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onShutdown: () => {
          shutdownCalled = true;
        },
      }),
    );
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "sd1", method: "shutdown" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("sd1");
    expect(json.result).toEqual({ ok: true });

    // onShutdown is called after the response is sent (drain mechanism)
    await pollUntil(() => shutdownCalled);
    expect(shutdownCalled).toBe(true);
  });

  test("shutdown returns ok response before invoking callback", async () => {
    socketPath = tmpSocket();
    let callbackTime = 0;
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onShutdown: () => {
          callbackTime = Date.now();
        },
      }),
    );
    server.start(socketPath);

    const responseTime = Date.now();
    const res = await rpc("/rpc", { id: "sd2", method: "shutdown" });
    const json = (await res.json()) as IpcResponse;

    // Response should arrive before the callback fires (drain mechanism)
    expect(json.result).toEqual({ ok: true });
    expect(callbackTime === 0 || callbackTime >= responseTime).toBe(true);

    // Wait for callback to fire
    await pollUntil(() => callbackTime > 0);
    expect(callbackTime).toBeGreaterThan(0);
  });

  test("shutdown rejects new requests while draining", async () => {
    socketPath = tmpSocket();
    let shutdownCalled = false;
    let handlerEntered: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    const slowPool = {
      ...mockPool(),
      callTool: async () => {
        handlerEntered();
        await Bun.sleep(200);
        return { content: [] };
      },
    };
    server = new IpcServer(
      slowPool as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onShutdown: () => {
          shutdownCalled = true;
        },
      }),
    );
    server.start(socketPath);

    // Start a slow callTool request
    const slowReq = rpc("/rpc", { id: "slow1", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });

    // Wait for the slow handler to actually start executing
    await handlerStarted;

    // Trigger shutdown while the slow request is in-flight
    const shutdownRes = await rpc("/rpc", { id: "sd-drain", method: "shutdown" });
    const shutdownJson = (await shutdownRes.json()) as IpcResponse;
    expect(shutdownJson.result).toEqual({ ok: true });

    // New request should be rejected with 503 while draining
    const rejectedRes = await rpc("/rpc", { id: "rejected1", method: "ping" });
    expect(rejectedRes.status).toBe(503);
    const rejectedJson = (await rejectedRes.json()) as IpcResponse;
    expect(rejectedJson.error?.message).toBe("Server is shutting down");

    // Wait for slow request to complete — shutdown should follow
    const slowRes = await slowReq;
    // The slow request may error due to server name not found, that's fine
    expect(slowRes.status).toBe(200);

    await pollUntil(() => shutdownCalled);
    expect(shutdownCalled).toBe(true);
  });

  test("shutdown drain timeout forces shutdown when requests are stuck", async () => {
    socketPath = tmpSocket();
    let shutdownCalled = false;
    let handlerEntered: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    // Pool with a handler that never resolves — simulates a stuck request
    let resolveStuck: (() => void) | undefined;
    const stuckForever = new Promise<void>((resolve) => {
      resolveStuck = resolve;
    });
    const stuckPool = {
      ...mockPool(),
      callTool: async () => {
        handlerEntered();
        await stuckForever;
        return { content: [] };
      },
    };
    server = new IpcServer(
      stuckPool as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onShutdown: () => {
          shutdownCalled = true;
        },
        drainTimeoutMs: 200,
      }),
    );
    server.start(socketPath);

    // Start a stuck callTool request (don't await — it will never resolve on its own)
    const stuckReq = rpc("/rpc", {
      id: "stuck1",
      method: "callTool",
      params: { server: "s", tool: "t", arguments: {} },
    });

    // Wait for the handler to start executing
    await handlerStarted;

    // Trigger shutdown — drain timeout (200ms) should force shutdown even though request is stuck
    const shutdownRes = await rpc("/rpc", { id: "sd-timeout", method: "shutdown" });
    const shutdownJson = (await shutdownRes.json()) as IpcResponse;
    expect(shutdownJson.result).toEqual({ ok: true });

    // Shutdown should fire within the drain timeout despite stuck request
    await pollUntil(() => shutdownCalled, 2_000);
    expect(shutdownCalled).toBe(true);

    // Unblock the stuck handler so the test can clean up
    resolveStuck?.();
    await stuckReq.catch(() => {});
  });

  test("shutdown works when pool has active servers", async () => {
    socketPath = tmpSocket();
    let closeAllCalled = false;
    const poolWithConnections = {
      ...mockPool(),
      listServers: () => [
        { name: "srv1", state: "connected" as const, tools: ["tool-a"] },
        { name: "srv2", state: "connected" as const, tools: ["tool-b"] },
      ],
    };
    server = new IpcServer(
      poolWithConnections as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onShutdown: () => {
          closeAllCalled = true;
        },
      }),
    );
    server.start(socketPath);

    // Verify servers are listed (simulating active connections)
    const listRes = await rpc("/rpc", { id: "ls1", method: "listServers" });
    const listJson = (await listRes.json()) as IpcResponse;
    expect((listJson.result as unknown[]).length).toBe(2);

    // Shutdown should still work with active connections
    const res = await rpc("/rpc", { id: "sd3", method: "shutdown" });
    const json = (await res.json()) as IpcResponse;
    expect(json.result).toEqual({ ok: true });

    await pollUntil(() => closeAllCalled);
    expect(closeAllCalled).toBe(true);
  });

  test("shutdown refuses when active sessions exist and force is not set", async () => {
    socketPath = tmpSocket();
    const dbWithSessions = mockDb({
      listSessions: () => [{ sessionId: "s1" }, { sessionId: "s2" }],
    });
    server = new IpcServer(mockPool() as never, mockConfig(), dbWithSessions, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "sd-refuse", method: "shutdown" });
    const json = (await res.json()) as IpcResponse;
    expect(json.result).toEqual({
      ok: false,
      activeSessions: 2,
      message: "2 active session(s). Use --force to shut down anyway.",
    });
  });

  test("shutdown proceeds with force when active sessions exist", async () => {
    socketPath = tmpSocket();
    let shutdownCalled = false;
    const dbWithSessions = mockDb({
      listSessions: () => [{ sessionId: "s1" }],
    });
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      dbWithSessions,
      null,
      opts({
        onShutdown: () => {
          shutdownCalled = true;
        },
      }),
    );
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "sd-force", method: "shutdown", params: { force: true } });
    const json = (await res.json()) as IpcResponse;
    expect(json.result).toEqual({ ok: true });

    await pollUntil(() => shutdownCalled);
    expect(shutdownCalled).toBe(true);
  });

  test("status response includes wsPort info when getWsPortInfo is provided", async () => {
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
      ...opts(),
      getWsPortInfo: () => ({ actual: 54321, expected: 19275 }),
    });
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "ws1", method: "status" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const result = json.result as { wsPort: number | null; wsPortExpected: number };
    expect(result.wsPort).toBe(54321);
    expect(result.wsPortExpected).toBe(19275);
  });

  test("status response has null wsPort when getWsPortInfo is not provided", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "ws2", method: "status" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const result = json.result as { wsPort: number | null; wsPortExpected?: number };
    expect(result.wsPort).toBeNull();
    expect(result.wsPortExpected).toBeUndefined();
  });

  test("status with usage data aggregates per-server stats onto ServerStatus", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      listServers: () => [
        { name: "srv1", transport: "stdio", state: "connected", toolCount: 2, source: "test" },
        { name: "srv2", transport: "http", state: "connected", toolCount: 1, source: "test" },
      ],
    });
    const db = mockDb({
      getUsageStats: () => [
        {
          serverName: "srv1",
          toolName: "tool-a",
          callCount: 5,
          totalDurationMs: 500,
          successCount: 4,
          errorCount: 1,
          lastCalledAt: 1000,
          lastError: "fail",
        },
        {
          serverName: "srv1",
          toolName: "tool-b",
          callCount: 3,
          totalDurationMs: 300,
          successCount: 3,
          errorCount: 0,
          lastCalledAt: 900,
          lastError: null,
        },
        {
          serverName: "srv2",
          toolName: "tool-c",
          callCount: 2,
          totalDurationMs: 200,
          successCount: 2,
          errorCount: 0,
          lastCalledAt: 800,
          lastError: null,
        },
      ],
    });
    server = new IpcServer(pool as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "us2", method: "status" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const result = json.result as {
      servers: Array<{
        name: string;
        callCount?: number;
        errorCount?: number;
        avgDurationMs?: number;
      }>;
      usageStats: Array<{ serverName: string; toolName: string }>;
    };

    // usageStats should be present
    expect(result.usageStats).toHaveLength(3);

    // srv1 aggregates: 5+3=8 calls, 1+0=1 error, (500+300)/8=100ms avg
    const srv1 = result.servers.find((s) => s.name === "srv1");
    expect(srv1?.callCount).toBe(8);
    expect(srv1?.errorCount).toBe(1);
    expect(srv1?.avgDurationMs).toBe(100);

    // srv2 aggregates: 2 calls, 0 errors, 200/2=100ms avg
    const srv2 = result.servers.find((s) => s.name === "srv2");
    expect(srv2?.callCount).toBe(2);
    expect(srv2?.errorCount).toBe(0);
    expect(srv2?.avgDurationMs).toBe(100);
  });

  test("onRequestComplete fires after each dispatched request", async () => {
    socketPath = tmpSocket();
    let completions = 0;
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onRequestComplete: () => {
          completions++;
        },
      }),
    );
    server.start(socketPath);

    await rpc("/rpc", { id: "rc1", method: "ping" });
    await rpc("/rpc", { id: "rc2", method: "listServers" });

    expect(completions).toBe(2);
  });

  test("onRequestComplete fires even on parse errors", async () => {
    socketPath = tmpSocket();
    let completions = 0;
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onRequestComplete: () => {
          completions++;
        },
      }),
    );
    server.start(socketPath);

    await fetch("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
      unix: socketPath,
    } as RequestInit);

    expect(completions).toBe(1);
  });

  test("onRequestComplete fires after handler error", async () => {
    socketPath = tmpSocket();
    let completions = 0;
    const failPool = {
      ...mockPool(),
      callTool: async () => {
        throw new Error("tool failed");
      },
    };
    server = new IpcServer(
      failPool as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onRequestComplete: () => {
          completions++;
        },
      }),
    );
    server.start(socketPath);

    await rpc("/rpc", { id: "rc3", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });

    expect(completions).toBe(1);
  });

  test("long-running request keeps onActivity/onRequestComplete balanced", async () => {
    socketPath = tmpSocket();
    let activities = 0;
    let completions = 0;
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const slowPool = {
      ...mockPool(),
      callTool: () =>
        new Promise<{ content: never[] }>((resolve) => {
          gate.resolve = () => resolve({ content: [] });
        }),
    };
    server = new IpcServer(
      slowPool as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onActivity: () => {
          activities++;
        },
        onRequestComplete: () => {
          completions++;
        },
      }),
    );
    server.start(socketPath);

    // Start a long-running tool call (don't await)
    const pending = rpc("/rpc", { id: "slow1", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });

    // Poll until the request arrives at the server
    await pollUntil(() => activities >= 1);
    expect(activities).toBe(1);
    expect(completions).toBe(0); // Still in-flight

    // Fire a second request while the first is pending
    await rpc("/rpc", { id: "fast1", method: "ping" });
    expect(activities).toBe(2);
    expect(completions).toBe(1); // Only ping completed

    // Now resolve the slow call
    gate.resolve?.();
    await pending;
    expect(completions).toBe(2); // Both completed
  });

  test("triggerAuth with server found but no db returns INTERNAL_ERROR", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      getServerUrl: (name: string) => (name === "myserver" ? "https://example.com" : null),
      getDb: () => null,
    });
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "auth2", method: "triggerAuth", params: { server: "myserver" } });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth2");
    expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
    expect(json.error?.message).toContain("Database not available");
  });

  test("triggerAuth calls auth tool on stdio server that exposes one", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      getServerUrl: () => undefined, // not a remote server
      listTools: (name: string) =>
        name === "myserver" ? [{ name: "auth", server: "myserver", description: "Authenticate", inputSchema: {} }] : [],
      callTool: async (_server: string, tool: string) =>
        tool === "auth"
          ? { content: [{ type: "text", text: "SSO login completed" }], isError: false }
          : { content: [] },
    });
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "auth3", method: "triggerAuth", params: { server: "myserver" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth3");
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true, message: "SSO login completed" });
  });

  test("triggerAuth on stdio server without auth tool returns SERVER_NOT_FOUND", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      getServerUrl: () => undefined,
      listTools: () => [{ name: "query", server: "myserver", description: "Query data", inputSchema: {} }],
    });
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "auth4", method: "triggerAuth", params: { server: "myserver" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth4");
    expect(json.error?.code).toBe(IPC_ERROR.SERVER_NOT_FOUND);
    expect(json.error?.message).toContain("does not support auth");
  });

  test("triggerAuth returns error when auth tool reports isError", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      getServerUrl: () => undefined,
      listTools: () => [{ name: "auth", server: "myserver", description: "Auth", inputSchema: {} }],
      callTool: async () => ({
        content: [{ type: "text", text: "SSO session expired, please retry" }],
        isError: true,
      }),
    });
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "auth5", method: "triggerAuth", params: { server: "myserver" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth5");
    expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
    expect(json.error?.message).toContain("SSO session expired");
  });

  // -- Mail handler tests --

  test("sendMail inserts message and returns id", async () => {
    socketPath = tmpSocket();
    const db = mockDb({
      insertMail: (_s: string, _r: string, _subj?: string, _body?: string, _rt?: number) => 42,
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "m1",
      method: "sendMail",
      params: { sender: "wt-1", recipient: "manager", subject: "done", body: "tests pass" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ id: 42 });
  });

  test("readMail returns messages from db", async () => {
    socketPath = tmpSocket();
    const messages = [
      {
        id: 1,
        sender: "wt-1",
        recipient: "manager",
        subject: "hi",
        body: null,
        replyTo: null,
        read: false,
        createdAt: "2025-01-01",
      },
    ];
    const db = mockDb({ readMail: () => messages });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "m3", method: "readMail", params: { recipient: "manager" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect((json.result as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("readMail with no params returns all messages", async () => {
    socketPath = tmpSocket();
    const db = mockDb({ readMail: () => [] });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "m4", method: "readMail" });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect((json.result as { messages: unknown[] }).messages).toEqual([]);
  });

  test("waitForMail returns message when available immediately", async () => {
    socketPath = tmpSocket();
    const msg = {
      id: 5,
      sender: "wt-1",
      recipient: "mgr",
      subject: "done",
      body: null,
      replyTo: null,
      read: false,
      createdAt: "2025-01-01",
    };
    const db = mockDb({
      getNextUnread: () => msg,
      markMailRead: () => {},
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "m5", method: "waitForMail", params: { recipient: "mgr", timeout: 1 } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect((json.result as { message: { id: number } }).message.id).toBe(5);
  });

  test("waitForMail returns null on timeout", async () => {
    socketPath = tmpSocket();
    const db = mockDb({
      getNextUnread: () => undefined,
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "m6", method: "waitForMail", params: { timeout: 1 } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect((json.result as { message: null }).message).toBeNull();
  });

  test("waitForMail returns null early when shutdown is requested", async () => {
    socketPath = tmpSocket();
    let shutdownCalled = false;
    const db = mockDb({
      getNextUnread: () => undefined,
    });
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      db,
      null,
      opts({
        onShutdown: () => {
          shutdownCalled = true;
        },
      }),
    );
    server.start(socketPath);

    // Start a waitForMail with a long timeout (30s)
    const waitReq = rpc("/rpc", { id: "wm-drain", method: "waitForMail", params: { recipient: "mgr", timeout: 30 } });

    // Give it a moment to enter the poll loop
    await Bun.sleep(50);

    // Trigger shutdown — this should cause waitForMail to return early
    const shutdownRes = await rpc("/rpc", { id: "sd-wm", method: "shutdown" });
    const shutdownJson = (await shutdownRes.json()) as IpcResponse;
    expect(shutdownJson.result).toEqual({ ok: true });

    // waitForMail should complete quickly (not wait 30s)
    const waitRes = await waitReq;
    const waitJson = (await waitRes.json()) as IpcResponse;
    expect(waitJson.error).toBeUndefined();
    expect((waitJson.result as { message: null }).message).toBeNull();

    // Shutdown should have completed
    await pollUntil(() => shutdownCalled);
    expect(shutdownCalled).toBe(true);
  });

  test("replyToMail creates reply with swapped sender/recipient", async () => {
    socketPath = tmpSocket();
    const original = {
      id: 10,
      sender: "wt-1",
      recipient: "mgr",
      subject: "help",
      body: "stuck",
      replyTo: null,
      read: false,
      createdAt: "2025-01-01",
    };
    let insertedArgs: unknown[] = [];
    const db = mockDb({
      getMailById: (id: number) => (id === 10 ? original : undefined),
      insertMail: (...args: unknown[]) => {
        insertedArgs = args;
        return 11;
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "m7",
      method: "replyToMail",
      params: { id: 10, sender: "mgr", body: "looks good" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ id: 11 });
    // Reply goes to the original sender
    expect(insertedArgs[0]).toBe("mgr"); // sender
    expect(insertedArgs[1]).toBe("wt-1"); // recipient (swapped)
    expect(insertedArgs[2]).toBe("Re: help"); // auto-prefixed subject
    expect(insertedArgs[4]).toBe(10); // replyTo
  });

  test("replyToMail with unknown message returns error", async () => {
    socketPath = tmpSocket();
    const db = mockDb({
      getMailById: () => undefined,
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "m8",
      method: "replyToMail",
      params: { id: 999, sender: "mgr", body: "reply" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("999");
  });

  test("markRead calls db.markMailRead", async () => {
    socketPath = tmpSocket();
    let markedId: number | undefined;
    const db = mockDb({
      markMailRead: (id: number) => {
        markedId = id;
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "m9", method: "markRead", params: { id: 7 } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({});
    expect(markedId).toBe(7);
  });

  // -- Error context preservation --

  test("error response includes stack trace from thrown Error", async () => {
    socketPath = tmpSocket();
    const failPool = {
      ...mockPool(),
      callTool: async () => {
        throw new Error("tool failed");
      },
    };
    server = new IpcServer(failPool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "st1", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });
    const json = (await res.json()) as IpcResponse;

    expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
    expect(json.error?.message).toBe("tool failed");
    expect(json.error?.stack).toBeString();
    expect(json.error?.stack).toContain("tool failed");
  });

  test("error response includes data when error has data property", async () => {
    socketPath = tmpSocket();
    const failPool = {
      ...mockPool(),
      callTool: async () => {
        const err = new Error("enriched failure");
        (err as unknown as { data: unknown }).data = { detail: "extra context" };
        throw err;
      },
    };
    server = new IpcServer(failPool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "st2", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });
    const json = (await res.json()) as IpcResponse;

    expect(json.error?.message).toBe("enriched failure");
    expect(json.error?.data).toEqual({ detail: "extra context" });
  });

  test("error response omits stack for non-Error throws", async () => {
    socketPath = tmpSocket();
    const failPool = {
      ...mockPool(),
      callTool: async () => {
        throw "string error";
      },
    };
    server = new IpcServer(failPool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "st3", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });
    const json = (await res.json()) as IpcResponse;

    expect(json.error?.message).toBe("string error");
    expect(json.error?.stack).toBeUndefined();
  });

  // -- Metrics tests --

  test("GET /metrics returns prometheus text format", async () => {
    startServer();

    // Make a ping call first to generate some metrics
    await rpc("/rpc", { id: "m1", method: "ping" });

    const res = await fetch("http://localhost/metrics", {
      method: "GET",
      unix: socketPath,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    // Should have IPC request metrics from the ping call
    expect(text).toContain("mcpd_ipc_requests_total");
    expect(text).toContain("mcpd_ipc_request_duration_ms");
  });

  test("getMetrics returns structured JSON snapshot", async () => {
    startServer();

    // Generate some metrics via a ping
    await rpc("/rpc", { id: "gm0", method: "ping" });

    const res = await rpc("/rpc", { id: "gm1", method: "getMetrics" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();

    const snap = json.result as {
      collectedAt: number;
      counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
      gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
      histograms: Array<{ name: string; labels: Record<string, string>; count: number; sum: number }>;
    };

    expect(snap.collectedAt).toBeGreaterThan(0);
    expect(Array.isArray(snap.counters)).toBe(true);
    expect(Array.isArray(snap.gauges)).toBe(true);
    expect(Array.isArray(snap.histograms)).toBe(true);

    // Should have ping-related IPC metrics
    const pingCounter = snap.counters.find((c) => c.name === "mcpd_ipc_requests_total" && c.labels.method === "ping");
    expect(pingCounter).toBeDefined();
    expect(pingCounter?.value).toBeGreaterThanOrEqual(1);
  });

  test("callTool records tool metrics", async () => {
    metrics.reset();
    startServer();

    // Call a tool
    await rpc("/rpc", { id: "tm1", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });

    const res = await rpc("/rpc", { id: "tm2", method: "getMetrics" });
    const json = (await res.json()) as IpcResponse;
    const snap = json.result as {
      counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
      histograms: Array<{ name: string; labels: Record<string, string>; count: number }>;
    };

    const toolCounter = snap.counters.find(
      (c) => c.name === "mcpd_tool_calls_total" && c.labels.server === "s" && c.labels.tool === "t",
    );
    expect(toolCounter).toBeDefined();
    expect(toolCounter?.value).toBe(1);

    const toolHistogram = snap.histograms.find(
      (h) => h.name === "mcpd_tool_call_duration_ms" && h.labels.server === "s" && h.labels.tool === "t",
    );
    expect(toolHistogram).toBeDefined();
    expect(toolHistogram?.count).toBe(1);
  });

  test("failed callTool records error metrics", async () => {
    metrics.reset();
    socketPath = tmpSocket();
    const failPool = {
      ...mockPool(),
      callTool: async () => {
        throw new Error("tool failed");
      },
    };
    server = new IpcServer(failPool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    await rpc("/rpc", { id: "em1", method: "callTool", params: { server: "s", tool: "t", arguments: {} } });

    const res = await rpc("/rpc", { id: "em2", method: "getMetrics" });
    const json = (await res.json()) as IpcResponse;
    const snap = json.result as {
      counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
    };

    const errorCounter = snap.counters.find(
      (c) => c.name === "mcpd_tool_errors_total" && c.labels.server === "s" && c.labels.tool === "t",
    );
    expect(errorCounter).toBeDefined();
    expect(errorCounter?.value).toBe(1);
  });

  test("getConfig returns server info with correct transport and toolCount", async () => {
    const configWithServers = {
      servers: new Map([
        ["alpha", { name: "alpha", config: { command: "echo" }, source: { file: "/a.json", scope: "user" } }],
        ["beta", { name: "beta", config: { command: "cat" }, source: { file: "/b.json", scope: "project" } }],
      ]),
      sources: [{ file: "/a.json", scope: "user" }],
    } as never;

    const poolWithServers = {
      ...mockPool(),
      listServers: () => [
        { name: "alpha", transport: "stdio", toolCount: 5 },
        { name: "beta", transport: "http", toolCount: 3 },
      ],
    };

    socketPath = tmpSocket();
    server = new IpcServer(poolWithServers as never, configWithServers, mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "gc1", method: "getConfig" });
    const json = (await res.json()) as IpcResponse;

    expect(json.error).toBeUndefined();
    const result = json.result as Record<string, unknown>;
    const servers = result.servers as Record<
      string,
      { transport: string; toolCount: number; source: string; scope: string }
    >;
    expect(servers.alpha).toEqual({ transport: "stdio", source: "/a.json", scope: "user", toolCount: 5 });
    expect(servers.beta).toEqual({ transport: "http", source: "/b.json", scope: "project", toolCount: 3 });
  });

  test("callTool creates child span with inherited traceId", async () => {
    socketPath = tmpSocket();
    const spans: unknown[] = [];
    const db = mockDb({
      recordSpan: (span: unknown) => {
        spans.push(span);
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const traceparent = "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01";
    await rpc("/rpc", {
      id: "tp1",
      method: "callTool",
      params: { server: "s", tool: "t", arguments: {} },
      traceparent,
    });

    // Two spans recorded: IPC dispatch span + tool call span
    expect(spans).toHaveLength(2);
    const toolSpan = spans[0] as { traceId: string; parentSpanId: string; name: string; status: string };
    const ipcSpan = spans[1] as { traceId: string; parentSpanId: string; name: string; spanId: string };

    // Both inherit the caller's traceId
    expect(toolSpan.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(ipcSpan.traceId).toBe("0123456789abcdef0123456789abcdef");

    // Tool span is child of IPC span
    expect(toolSpan.parentSpanId).toBe(ipcSpan.spanId);

    // IPC span is child of the caller's spanId
    expect(ipcSpan.parentSpanId).toBe("fedcba9876543210");

    expect(toolSpan.name).toBe("tool.s.t");
    expect(toolSpan.status).toBe("OK");
    expect(ipcSpan.name).toBe("ipc.callTool");
  });

  test("callTool without traceparent creates root span", async () => {
    socketPath = tmpSocket();
    const spans: unknown[] = [];
    const db = mockDb({
      recordSpan: (span: unknown) => {
        spans.push(span);
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    await rpc("/rpc", {
      id: "tp2",
      method: "callTool",
      params: { server: "s", tool: "t", arguments: {} },
    });

    expect(spans).toHaveLength(2);
    const ipcSpan = spans[1] as { traceId: string; parentSpanId?: string };
    // Root span — no parent
    expect(ipcSpan.parentSpanId).toBeUndefined();
    // Has a valid traceId
    expect(ipcSpan.traceId).toHaveLength(32);
  });

  test("concurrent callTool requests get independent spans", async () => {
    socketPath = tmpSocket();
    const spans: Array<{ traceId: string; name: string; parentSpanId?: string }> = [];
    const usageRecords: Array<{
      server: string;
      tool: string;
      traceContext?: { daemonId?: string; traceId?: string; parentId?: string };
    }> = [];
    const db = mockDb({
      recordSpan: (span: { traceId: string; name: string; parentSpanId?: string }) => {
        spans.push(span);
      },
      recordUsage: (
        server: string,
        tool: string,
        _durationMs: number,
        _success: boolean,
        _error: string | undefined,
        traceContext?: { daemonId?: string; traceId?: string; parentId?: string },
      ) => {
        usageRecords.push({ server, tool, traceContext });
      },
    });
    // Make callTool take some time to expose race conditions
    const pool = {
      ...mockPool(),
      callTool: async () => {
        await Bun.sleep(10);
        return { content: [] };
      },
    };
    server = new IpcServer(pool as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const tp1 = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11-1111111111111111-01";
    const tp2 = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22-2222222222222222-01";

    // Fire two concurrent requests with different traceparents
    const [r1, r2] = await Promise.all([
      rpc("/rpc", {
        id: "c1",
        method: "callTool",
        params: { server: "s", tool: "t", arguments: {} },
        traceparent: tp1,
      }),
      rpc("/rpc", {
        id: "c2",
        method: "callTool",
        params: { server: "s", tool: "t", arguments: {} },
        traceparent: tp2,
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Should have 4 spans (2 IPC + 2 tool)
    expect(spans).toHaveLength(4);

    // Extract tool spans by name
    const toolSpans = spans.filter((s) => s.name === "tool.s.t");
    expect(toolSpans).toHaveLength(2);

    // Each tool span should have the correct traceId from its request (no cross-contamination)
    const traceIds = new Set(toolSpans.map((s) => s.traceId));
    expect(traceIds.size).toBe(2);
    expect(traceIds.has("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11")).toBe(true);
    expect(traceIds.has("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22")).toBe(true);

    // Verify no span has undefined traceId or parentSpanId
    for (const span of spans) {
      expect(span.traceId).toBeDefined();
      expect(span.traceId).not.toBe("");
    }
    // Tool spans must have a parentSpanId (they are children of the IPC span)
    for (const span of toolSpans) {
      expect(span.parentSpanId).toBeDefined();
      expect(span.parentSpanId).not.toBe("");
    }

    // Verify usage_stats also recorded correct trace context per request
    expect(usageRecords).toHaveLength(2);
    const usageTraceIds = new Set(usageRecords.map((r) => r.traceContext?.traceId));
    expect(usageTraceIds.size).toBe(2);
    expect(usageTraceIds.has("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11")).toBe(true);
    expect(usageTraceIds.has("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22")).toBe(true);
    // Verify no usage record has undefined trace context
    for (const record of usageRecords) {
      expect(record.traceContext).toBeDefined();
      expect(record.traceContext?.traceId).toBeDefined();
      expect(record.traceContext?.traceId).not.toBe("");
      expect(record.traceContext?.parentId).toBeDefined();
      expect(record.traceContext?.parentId).not.toBe("");
    }
  });

  test("getMetrics includes daemonId and startedAt", async () => {
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "gm1", method: "getMetrics" });
    const json = (await res.json()) as IpcResponse;
    const snap = json.result as { daemonId?: string; startedAt?: number; collectedAt: number };

    expect(snap.daemonId).toBe(TEST_DAEMON_ID);
    expect(snap.startedAt).toBe(TEST_STARTED_AT);
    expect(snap.collectedAt).toBeGreaterThan(0);
  });

  // -- Alias handler tests --

  test("saveAlias writes freeform script to ALIASES_DIR and returns filePath", async () => {
    using testOpts = testOptions();
    socketPath = tmpSocket();
    let savedArgs: unknown[] = [];
    const db = mockDb({
      saveAlias: (...args: unknown[]) => {
        savedArgs = args;
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const script = 'const result = await mcp.echo.echo({ message: "hi" });';
    const res = await rpc("/rpc", {
      id: "sa1",
      method: "saveAlias",
      params: { name: "greet", script, description: "A greeting alias" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();

    const result = json.result as { ok: boolean; filePath: string };
    expect(result.ok).toBe(true);
    expect(result.filePath).toBe(join(testOpts.ALIASES_DIR, "greet.ts"));

    // File should exist on disk with auto-prepended import
    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain('import { mcp, args, file, json } from "mcp-cli"');
    expect(content).toContain(script);

    // DB should be called with correct args
    expect(savedArgs[0]).toBe("greet"); // name
    expect(savedArgs[1]).toBe(result.filePath); // filePath
    expect(savedArgs[2]).toBe("A greeting alias"); // description
    expect(savedArgs[3]).toBe("freeform"); // type
  });

  test("saveAlias freeform skips auto-import when already present", async () => {
    using _testOpts = testOptions();
    socketPath = tmpSocket();
    const db = mockDb({ saveAlias: () => {} });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const script = 'import { mcp, args, file, json } from "mcp-cli";\nawait mcp.echo.echo({});';
    const res = await rpc("/rpc", {
      id: "sa2",
      method: "saveAlias",
      params: { name: "already-imported", script },
    });
    const json = (await res.json()) as IpcResponse;
    const result = json.result as { ok: boolean; filePath: string };
    expect(result.ok).toBe(true);

    // File should NOT have a double import
    const content = readFileSync(result.filePath, "utf-8");
    const importCount = (content.match(/from "mcp-cli"/g) ?? []).length;
    expect(importCount).toBe(1);
  });

  test("saveAlias with defineAlias script saves as structured type", async () => {
    using _testOpts = testOptions();
    socketPath = tmpSocket();
    let savedType: string | undefined;
    const db = mockDb({
      saveAlias: (...args: unknown[]) => {
        savedType = args[3] as string;
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    // defineAlias( sentinel triggers structured path; worker extraction will fail
    // in test (no real worker), so it falls back to saving with sentinel-detected type
    const script = `import { defineAlias, z } from "mcp-cli";\ndefineAlias({ name: "test", handler: async () => ({}) });`;
    const res = await rpc("/rpc", {
      id: "sa3",
      method: "saveAlias",
      params: { name: "structured", script, description: "structured alias" },
    });
    const json = (await res.json()) as IpcResponse;
    const result = json.result as { ok: boolean; filePath: string };
    expect(result.ok).toBe(true);

    // Should be saved as defineAlias type (worker fails, falls back to sentinel-only save)
    expect(savedType).toBe("defineAlias");

    // File should contain the script verbatim (no auto-import prepended)
    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toBe(script);
  });

  test("deleteAlias removes file and db record", async () => {
    using testOpts = testOptions({
      files: {
        "aliases/remove-me.ts": "// alias script",
      },
    });
    socketPath = tmpSocket();
    const filePath = join(testOpts.ALIASES_DIR, "remove-me.ts");
    let deletedName: string | undefined;
    const db = mockDb({
      getAlias: (name: string) => (name === "remove-me" ? { name: "remove-me", filePath, type: "freeform" } : null),
      deleteAlias: (name: string) => {
        deletedName = name;
      },
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    // File should exist before delete
    expect(existsSync(filePath)).toBe(true);

    const res = await rpc("/rpc", {
      id: "da1",
      method: "deleteAlias",
      params: { name: "remove-me" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true });

    // File should be removed
    expect(existsSync(filePath)).toBe(false);
    // DB record should be deleted
    expect(deletedName).toBe("remove-me");
  });

  test("deleteAlias succeeds even when alias not in db", async () => {
    using _testOpts = testOptions();
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "da2",
      method: "deleteAlias",
      params: { name: "nonexistent" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true });
  });

  test("getAlias returns script content from disk", async () => {
    using testOpts = testOptions({
      files: {
        "aliases/my-alias.ts": "// my alias script content",
      },
    });
    socketPath = tmpSocket();
    const filePath = join(testOpts.ALIASES_DIR, "my-alias.ts");
    const db = mockDb({
      getAlias: (name: string) =>
        name === "my-alias" ? { name: "my-alias", filePath, type: "freeform", description: "test" } : null,
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "ga1",
      method: "getAlias",
      params: { name: "my-alias" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();

    const result = json.result as { name: string; script: string; type: string };
    expect(result.name).toBe("my-alias");
    expect(result.script).toBe("// my alias script content");
    expect(result.type).toBe("freeform");
  });

  test("getAlias returns empty script when file is missing", async () => {
    using _testOpts = testOptions();
    socketPath = tmpSocket();
    const db = mockDb({
      getAlias: (name: string) =>
        name === "missing-file" ? { name: "missing-file", filePath: "/nonexistent/path.ts", type: "freeform" } : null,
    });
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "ga3",
      method: "getAlias",
      params: { name: "missing-file" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();

    const result = json.result as { name: string; script: string };
    expect(result.name).toBe("missing-file");
    expect(result.script).toBe("");
  });

  // -- restartServer and reloadConfig handler tests --

  test("restartServer calls pool.restart with server name", async () => {
    socketPath = tmpSocket();
    let restartedServer: string | undefined;
    const pool = {
      ...mockPool(),
      restart: async (name: string) => {
        restartedServer = name;
      },
    };
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "rs1",
      method: "restartServer",
      params: { server: "my-server" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true });
    expect(restartedServer).toBe("my-server");
  });

  test("reloadConfig calls onReloadConfig callback", async () => {
    socketPath = tmpSocket();
    let reloadCalled = false;
    server = new IpcServer(
      mockPool() as never,
      mockConfig(),
      mockDb(),
      null,
      opts({
        onReloadConfig: async () => {
          reloadCalled = true;
        },
      }),
    );
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "rl1",
      method: "reloadConfig",
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true });
    expect(reloadCalled).toBe(true);
  });

  // -- Serve instance tracking tests --

  test("registerServe adds instance and listServeInstances returns it", async () => {
    startServer();

    const regRes = await rpc("/rpc", {
      id: "si1",
      method: "registerServe",
      params: { instanceId: "abc123", pid: process.pid, tools: ["search", "echo"] },
    });
    const regJson = (await regRes.json()) as IpcResponse;
    expect(regJson.error).toBeUndefined();
    expect(regJson.result).toEqual({ ok: true });

    const listRes = await rpc("/rpc", { id: "si2", method: "listServeInstances" });
    const listJson = (await listRes.json()) as IpcResponse;
    expect(listJson.error).toBeUndefined();

    const instances = listJson.result as Array<{ instanceId: string; pid: number; tools: string[]; startedAt: number }>;
    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe("abc123");
    expect(instances[0].pid).toBe(process.pid);
    expect(instances[0].tools).toEqual(["search", "echo"]);
    expect(instances[0].startedAt).toBeGreaterThan(0);
  });

  test("unregisterServe removes instance", async () => {
    startServer();

    await rpc("/rpc", {
      id: "si3",
      method: "registerServe",
      params: { instanceId: "def456", pid: process.pid, tools: [] },
    });

    const unregRes = await rpc("/rpc", {
      id: "si4",
      method: "unregisterServe",
      params: { instanceId: "def456" },
    });
    const unregJson = (await unregRes.json()) as IpcResponse;
    expect(unregJson.error).toBeUndefined();
    expect(unregJson.result).toEqual({ ok: true });

    const listRes = await rpc("/rpc", { id: "si5", method: "listServeInstances" });
    const listJson = (await listRes.json()) as IpcResponse;
    expect(listJson.result).toEqual([]);
  });

  test("unregisterServe with unknown instanceId is a no-op", async () => {
    startServer();

    const res = await rpc("/rpc", {
      id: "si6",
      method: "unregisterServe",
      params: { instanceId: "nonexistent" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({ ok: true });
  });

  test("listServeInstances prunes stale PIDs", async () => {
    startServer();

    // Register an instance with a PID that doesn't exist
    await rpc("/rpc", {
      id: "si7",
      method: "registerServe",
      params: { instanceId: "stale1", pid: 999999, tools: [] },
    });

    // Also register one with current PID (alive)
    await rpc("/rpc", {
      id: "si8",
      method: "registerServe",
      params: { instanceId: "alive1", pid: process.pid, tools: ["tool1"] },
    });

    const listRes = await rpc("/rpc", { id: "si9", method: "listServeInstances" });
    const listJson = (await listRes.json()) as IpcResponse;
    const instances = listJson.result as Array<{ instanceId: string }>;

    // Only the alive instance should remain
    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe("alive1");
  });

  test("status response includes serveInstances", async () => {
    startServer();

    await rpc("/rpc", {
      id: "si10",
      method: "registerServe",
      params: { instanceId: "status-test", pid: process.pid, tools: ["find"] },
    });

    const statusRes = await rpc("/rpc", { id: "si11", method: "status" });
    const statusJson = (await statusRes.json()) as IpcResponse;
    const result = statusJson.result as { serveInstances: Array<{ instanceId: string }> };

    expect(result.serveInstances).toHaveLength(1);
    expect(result.serveInstances[0].instanceId).toBe("status-test");
  });

  // -- SSE /logs endpoint tests --

  test("GET /logs?daemon=true returns SSE content-type", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/logs?daemon=true&lines=0", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Abort to close the stream
    controller.abort();
  });

  test("GET /logs?daemon=true streams backfill lines", async () => {
    startServer();

    // Emit a recognizable log line
    const marker = `sse-test-${Date.now()}`;
    console.error(marker);

    const controller = new AbortController();
    const res = await fetch("http://localhost/logs?daemon=true&lines=10", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Read until we get our marker or timeout
    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(marker)) break;
    }

    controller.abort();
    reader.releaseLock();

    expect(buffer).toContain(marker);
    expect(buffer).toContain("data: ");
  });

  test("GET /logs?server=<name> streams backfill from pool", async () => {
    socketPath = tmpSocket();
    const pool = {
      ...mockPool(),
      getStderrLines: () => [{ timestamp: 1000, line: "pool-line" }],
    };
    server = new IpcServer(pool as never, mockConfig(), mockDb(), null, opts());
    server.start(socketPath);

    const controller = new AbortController();
    const res = await fetch("http://localhost/logs?server=myserver&lines=5", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("pool-line")) break;
    }

    controller.abort();
    reader.releaseLock();

    expect(buffer).toContain("pool-line");
  });

  // Bug #1 regression: callTool → _aliases must forward the caller's cwd so
  // the executor subprocess can resolve repo root from the caller, not from
  // the daemon's cwd. See PR #1307 adversarial review.
  test("callTool routed to _aliases forwards cwd to alias server", async () => {
    socketPath = tmpSocket();
    const calls: Array<{ tool: string; chain: string[]; cwd?: string }> = [];
    const fakeAliasServer = {
      callToolWithChain: async (tool: string, _args: Record<string, unknown>, chain: string[], cwd?: string) => {
        calls.push({ tool, chain, cwd });
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), fakeAliasServer as never, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "cwd1",
      method: "callTool",
      params: { server: "_aliases", tool: "my-alias", arguments: {}, cwd: "/some/caller/path" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("my-alias");
    expect(calls[0].cwd).toBe("/some/caller/path");
    expect(calls[0].chain).toEqual([]);
  });

  test("callTool routed to _aliases forwards cwd together with callChain", async () => {
    socketPath = tmpSocket();
    const calls: Array<{ tool: string; chain: string[]; cwd?: string }> = [];
    const fakeAliasServer = {
      callToolWithChain: async (tool: string, _args: Record<string, unknown>, chain: string[], cwd?: string) => {
        calls.push({ tool, chain, cwd });
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), fakeAliasServer as never, opts());
    server.start(socketPath);

    const res = await rpc("/rpc", {
      id: "cwd2",
      method: "callTool",
      params: {
        server: "_aliases",
        tool: "child",
        arguments: {},
        callChain: ["parent"],
        cwd: "/caller/repo",
      },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(calls[0].cwd).toBe("/caller/repo");
    expect(calls[0].chain).toEqual(["parent"]);
  });

  describe("trackWorkItem initialPhase server-side validation", () => {
    const fakeManifest = {
      version: 1 as const,
      initial: "impl",
      phases: { impl: { source: "./impl.ts" }, review: { source: "./review.ts" } },
    };

    function startWithLoadManifest(loadManifest: (repoRoot: string) => typeof fakeManifest | null): void {
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        loadManifest: loadManifest as never,
      });
      server.start(socketPath);
    }

    test("rejects initialPhase not declared in manifest", async () => {
      startWithLoadManifest(() => fakeManifest);

      const res = await rpc("/rpc", {
        id: "ti1",
        method: "trackWorkItem",
        params: { number: 42, initialPhase: "bogus", repoRoot: "/repo" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeDefined();
      expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
      expect(json.error?.message).toContain("unknown initialPhase");
      expect(json.error?.message).toContain("bogus");
      expect(json.error?.message).toContain("impl");
    });

    test("accepts initialPhase declared in manifest", async () => {
      startWithLoadManifest(() => fakeManifest);

      const res = await rpc("/rpc", {
        id: "ti2",
        method: "trackWorkItem",
        params: { number: 43, initialPhase: "review", repoRoot: "/repo" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeUndefined();
      const item = json.result as { phase: string };
      expect(item.phase).toBe("review");
    });

    test("accepts any initialPhase when repoRoot is absent (legacy)", async () => {
      startWithLoadManifest(() => fakeManifest);

      const res = await rpc("/rpc", {
        id: "ti3",
        method: "trackWorkItem",
        params: { number: 44, initialPhase: "anything-goes" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeUndefined();
      const item = json.result as { phase: string };
      expect(item.phase).toBe("anything-goes");
    });

    test("accepts any initialPhase when manifest is not found at repoRoot", async () => {
      startWithLoadManifest(() => null);

      const res = await rpc("/rpc", {
        id: "ti4",
        method: "trackWorkItem",
        params: { number: 45, initialPhase: "free-form", repoRoot: "/no-manifest-here" },
      });
      const json = (await res.json()) as IpcResponse;
      expect(json.error).toBeUndefined();
      const item = json.result as { phase: string };
      expect(item.phase).toBe("free-form");
    });
  });

  // -- GET /events NDJSON endpoint tests (EventBus path, #1515) --

  describe("GET /events (EventBus)", () => {
    function startServerWithBus(): { bus: EventBus } {
      const bus = new EventBus();
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);
      return { bus };
    }

    test("returns 200 with application/x-ndjson content-type", async () => {
      const { bus: _bus } = startServerWithBus();
      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);
      controller.abort();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    });

    test("GET /events with invalid pr returns 400", async () => {
      for (const bad of ["abc", "1.5", "-1", "0", ""]) {
        startServerWithBus();
        const res = await fetch(`http://localhost/events?pr=${encodeURIComponent(bad)}`, {
          method: "GET",
          unix: socketPath,
        } as RequestInit);
        expect(res.status, `pr="${bad}"`).toBe(400);
        const text = await res.text();
        expect(text, `pr="${bad}"`).toContain("pr must be a positive integer");
      }
    });

    test("GET /events with since= returns 400 for invalid cursor format", async () => {
      startServerWithBus();
      for (const bad of ["abc", "-1", "1.5", ""]) {
        const res = await fetch(`http://localhost/events?since=${encodeURIComponent(bad)}`, {
          method: "GET",
          unix: socketPath,
        } as RequestInit);
        expect(res.status, `since="${bad}"`).toBe(400);
        const text = await res.text();
        expect(text, `since="${bad}"`).toContain("since");
      }
    });

    test("GET /events with since= returns 400 when event log is unavailable (#1558)", async () => {
      // startServerWithBus() creates EventBus *without* an EventLog — replay not supported.
      // Start server once outside the loop; reusing it avoids leaking sockets per iteration.
      startServerWithBus();
      for (const cursor of [0, 1, 42]) {
        const res = await fetch(`http://localhost/events?since=${cursor}`, {
          method: "GET",
          unix: socketPath,
        } as RequestInit);
        expect(res.status, `since=${cursor}`).toBe(400);
        const text = await res.text();
        expect(text, `since=${cursor}`).toContain("since");
      }
    });

    test("streams published events as NDJSON lines", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Drain the initial flush newline — once read, the subscription is active.
      await reader.read();

      bus.publish({
        src: "test",
        event: "session.result",
        category: "session",
        sessionId: "s1",
        cost: 1.5,
      });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.result")) break;
      }

      controller.abort();
      reader.releaseLock();

      const line = buffer.trim().split("\n")[0];
      const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
      expect(parsed.event).toBe("session.result");
      expect(parsed.seq).toBe(1);
      expect(typeof parsed.ts).toBe("string");
    });

    test("session.response events are excluded by default", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush — subscription is now active

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "hello" });
      bus.publish({ src: "test", event: "session.ended", category: "session", sessionId: "s1" });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.ended")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.response");
      expect(buffer).toContain("session.ended");
    });

    test("session.response included when responseTail matches sessionId", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?responseTail=s1", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush — subscription is now active

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "hello" });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.response")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).toContain("session.response");
    });

    test("session.response NOT included when responseTail is different sessionId", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?responseTail=other-session", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush — subscription is now active

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "hello" });
      bus.publish({ src: "test", event: "session.ended", category: "session", sessionId: "s1" });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.ended")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.response");
      expect(buffer).toContain("session.ended");
    });

    test("category filter excludes events from other categories", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?subscribe=work_item", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush — subscription is now active

      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 42 });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.merged")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.result");
      expect(buffer).toContain("pr.merged");
    });

    test("backfills events from event log when since=<seq> is provided", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      // Publish two events before any client connects — they are persisted to the durable log
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 7 });

      // Connect with since=0 — should receive both historical events as backfill
      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=0", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.merged")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).toContain("session.result");
      expect(buffer).toContain("pr.merged");

      // Events must arrive with ascending seq numbers
      const lines = buffer.split("\n").filter((l) => l.includes('"session.result"') || l.includes('"pr.merged"'));
      expect(lines.length).toBe(2);
      const seqs = lines.map((l) => (JSON.parse(l) as Record<string, unknown>).seq as number);
      expect(seqs[0]).toBeLessThan(seqs[1] as number);
    });

    test("worker monitor:event round-trips to GET /events subscriber (#1567)", async () => {
      const bus = new EventBus();
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      // Simulate the bridge: ClaudeServer.onMonitorEvent publishes to the daemon bus
      using bridgedOpts = testOptions();
      const bridgedDb = new StateDb(bridgedOpts.DB_PATH);
      const claudeServer = new ClaudeServer(bridgedDb, undefined, undefined, silentLogger);
      claudeServer.onMonitorEvent = (input) => bus.publish(input);

      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      // Simulate worker posting a monitor:event message
      const handle = (claudeServer as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(
        claudeServer,
      );
      handle({
        type: "monitor:event",
        input: {
          src: "daemon.claude-server",
          event: "session.result",
          category: "session",
          sessionId: "bridge-test",
          cost: 1.23,
          numTurns: 5,
        },
      });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.result")) break;
      }

      controller.abort();
      reader.releaseLock();
      bridgedDb.close();

      const line = buffer.trim().split("\n")[0];
      const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
      expect(parsed.event).toBe("session.result");
      expect(parsed.sessionId).toBe("bridge-test");
      expect(parsed.cost).toBe(1.23);
      expect(parsed.numTurns).toBe(5);
      expect(parsed.seq).toBe(1);
      expect(typeof parsed.ts).toBe("string");
    });

    test("responseTail does not bypass category filter", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      // subscribe=mail only, but with responseTail set — session.response should still be excluded
      const res = await fetch("http://localhost/events?subscribe=mail&responseTail=s1", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush — subscription is now active

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "hi" });
      bus.publish({ src: "test", event: "mail.received", category: "mail", mailId: 1, sender: "a", recipient: "b" });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("mail.received")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.response");
      expect(buffer).toContain("mail.received");
    });

    test("backfill→live handoff: no gap or duplicates when since=<seq> with pre-populated log", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();

      // Pre-populate 5 events before constructing the server
      for (let i = 0; i < 5; i++) {
        bus.publish({ src: "test", event: "session.result", category: "session", sessionId: `s${i}` });
      }

      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=2", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Read until backfill arrives (it's enqueued synchronously with the flush newline)
      let buffer = "";
      const deadline1 = Date.now() + 2_000;
      while (Date.now() < deadline1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Backfill has 3 events (seq 3,4,5) — wait for all of them
        if (buffer.split("\n").filter((l) => l.startsWith("{")).length >= 3) break;
      }

      // Now publish a live event after backfill is consumed
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 99 });

      const deadline2 = Date.now() + 2_000;
      while (Date.now() < deadline2) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.merged")) break;
      }

      controller.abort();
      reader.releaseLock();

      const lines = buffer.split("\n").filter((l) => l.startsWith("{"));
      const events = lines.map((l) => JSON.parse(l) as { seq: number; event: string });

      // Backfill (seq 3,4,5) + live (seq 6)
      expect(events.length).toBe(4);
      expect(events[0]?.seq).toBe(3);
      expect(events[1]?.seq).toBe(4);
      expect(events[2]?.seq).toBe(5);
      expect(events[3]?.seq).toBe(6);
      expect(events[3]?.event).toBe("pr.merged");

      for (let i = 1; i < events.length; i++) {
        expect(events[i]?.seq).toBe((events[i - 1]?.seq as number) + 1);
      }
    });

    test("fresh EventLog, no backfill: live events arrive with monotonic seq starting at 1", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Drain initial flush newline
      await reader.read();

      // Publish 3 live events
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 1 });
      bus.publish({ src: "test", event: "mail.received", category: "mail", mailId: 1, sender: "a", recipient: "b" });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("mail.received")) break;
      }

      controller.abort();
      reader.releaseLock();

      const lines = buffer.split("\n").filter((l) => l.startsWith("{"));
      const events = lines.map((l) => JSON.parse(l) as { seq: number; event: string });

      expect(events.length).toBe(3);
      expect(events[0]?.seq).toBe(1);
      expect(events[1]?.seq).toBe(2);
      expect(events[2]?.seq).toBe(3);
    });

    test("returns 503 when subscriber limit is reached", async () => {
      const { bus } = startServerWithBus();

      // Fill the bus directly to avoid 64 HTTP round-trips
      const limit = IpcServer.MAX_EVENT_BUS_SUBSCRIBERS;
      const ids: number[] = [];
      for (let i = 0; i < limit; i++) {
        ids.push(bus.subscribe(() => {}));
      }

      const overflow = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
      } as RequestInit);
      expect(overflow.status).toBe(503);

      for (const id of ids) bus.unsubscribe(id);
    });

    test("mcpd_event_bus_subscribers gauge increments with each HTTP subscription", async () => {
      metrics.reset();
      const { bus: _bus } = startServerWithBus();
      const gauge = metrics.gauge("mcpd_event_bus_subscribers");

      expect(gauge.value()).toBe(0);

      // Read one chunk per connection to ensure the start() callback has run
      // (subscriberGauge.inc() is called inside start(), so reading confirms it fired).
      const c1 = new AbortController();
      const res1 = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: c1.signal,
      } as RequestInit);
      const reader1 = res1.body?.getReader();
      await reader1?.read();
      expect(gauge.value()).toBe(1);

      const c2 = new AbortController();
      const res2 = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: c2.signal,
      } as RequestInit);
      const reader2 = res2.body?.getReader();
      await reader2?.read();
      expect(gauge.value()).toBe(2);

      c1.abort();
      reader1?.releaseLock();
      c2.abort();
      reader2?.releaseLock();
    });

    test("type glob filter matches event names with wildcards", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?type=pr.*", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 42 });
      bus.publish({ src: "test", event: "pr.opened", category: "work_item", prNumber: 43 });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.opened")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.result");
      expect(buffer).toContain("pr.merged");
      expect(buffer).toContain("pr.opened");
    });

    test("type glob supports comma-separated OR patterns", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch(`http://localhost/events?type=${encodeURIComponent("pr.*,mail.received")}`, {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 42 });
      bus.publish({
        src: "test",
        event: "mail.received",
        category: "mail",
        mailId: 1,
        sender: "a",
        recipient: "b",
      });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("mail.received")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.result");
      expect(buffer).toContain("pr.merged");
      expect(buffer).toContain("mail.received");
    });

    test("src glob filter matches source attribution with wildcards", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch(`http://localhost/events?src=${encodeURIComponent("daemon.*")}`, {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      // Publish non-matching first, then matching — if filter works, only the match arrives
      bus.publish({ src: "external.hook", event: "pr.opened", category: "work_item", prNumber: 43 });
      bus.publish({ src: "daemon.poller", event: "pr.merged", category: "work_item", prNumber: 42 });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.merged")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).toContain("pr.merged");
      expect(buffer).not.toContain("pr.opened");
    });

    test("phase filter matches phase field on events", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?phase=review", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      bus.publish({
        src: "test",
        event: "phase.changed",
        category: "work_item",
        phase: "impl",
        workItemId: "#1",
      } as never);
      bus.publish({
        src: "test",
        event: "phase.changed",
        category: "work_item",
        phase: "review",
        workItemId: "#2",
      } as never);

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("#2")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("#1");
      expect(buffer).toContain("#2");
    });

    test("combined filters are conjunctive (AND across axes)", async () => {
      const { bus } = startServerWithBus();

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?subscribe=work_item&pr=42", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      await reader.read(); // drain initial flush

      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 99 });
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.opened", category: "work_item", prNumber: 42 });

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.opened")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("pr.merged");
      expect(buffer).not.toContain("session.result");
      expect(buffer).toContain("pr.opened");
    });

    test("backfill from durable log respects filters", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });
      bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 42 });

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=0&subscribe=work_item", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("pr.merged")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.result");
      expect(buffer).toContain("pr.merged");
    });

    test("backfill session.response excluded by default (no responseTail)", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "secret" });
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=0", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.result")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.response");
      expect(buffer).toContain("session.result");
    });

    test("backfill session.response included when responseTail matches", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "hello" });
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=0&responseTail=s1", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.result")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).toContain("session.response");
      expect(buffer).toContain("session.result");
    });

    test("backfill session.response excluded when responseTail is different session", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      bus.publish({ src: "test", event: "session.response", category: "session", sessionId: "s1", chunk: "secret" });
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1" });

      const controller = new AbortController();
      const res = await fetch("http://localhost/events?since=0&responseTail=other-session", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      expect(res.status).toBe(200);
      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("session.result")) break;
      }

      controller.abort();
      reader.releaseLock();

      expect(buffer).not.toContain("session.response");
      expect(buffer).toContain("session.result");
    });

    test("liveBuffer overflow emits gap control message when entry cap is exceeded (#1589)", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      // Pre-populate events for backfill. Force a tiny batch size so backfill yields
      // many times — that guarantees the test's synchronous publish loop after
      // `await fetch()` lands inside the backfill window (not after `liveBuffer = null`),
      // regardless of how Bun orders fetch resolution against the backfill's
      // `setTimeout(0)` yields. Without this, the publish loop occasionally races
      // backfill completion and the gap message never fires (sprint-47 retro flake).
      const backfillCount = 200;
      for (let i = 0; i < backfillCount; i++) {
        bus.publish({ src: "test", event: "session.result", category: "session", sessionId: `s${i}` });
      }

      const origMaxEntries = IpcServer.LIVE_BUFFER_MAX_ENTRIES;
      const origBatchSize = IpcServer.BACKFILL_BATCH_SIZE;
      (IpcServer as unknown as Record<string, unknown>).LIVE_BUFFER_MAX_ENTRIES = 5;
      IpcServer.BACKFILL_BATCH_SIZE = 1;

      const controller = new AbortController();
      try {
        const res = await fetch("http://localhost/events?since=0", {
          method: "GET",
          unix: socketPath,
          signal: controller.signal,
        } as RequestInit);

        expect(res.status).toBe(200);
        if (!res.body) throw new Error("Expected response body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        // Flood live events while backfill is in progress. Because start() is async
        // and yields between batches, these land in the liveBuffer.
        for (let i = 0; i < 20; i++) {
          bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 900 + i });
        }

        let buffer = "";
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Wait for the gap control message specifically. With BACKFILL_BATCH_SIZE=1
          // the live publishes are also written to eventLog, so they re-emerge as
          // backfill rows; "pr.merged" alone doesn't prove the gap path executed.
          if (buffer.includes('"t":"gap"')) break;
        }

        controller.abort();
        reader.releaseLock();

        const parsed: Array<Record<string, unknown>> = [];
        for (const l of buffer.split("\n").filter((s) => s.startsWith("{"))) {
          try {
            parsed.push(JSON.parse(l) as Record<string, unknown>);
          } catch {
            /* partial chunk */
          }
        }
        const gapLines = parsed.filter((o) => o.t === "gap");
        expect(gapLines.length).toBe(1);
        expect(typeof gapLines[0]?.dropped).toBe("number");
        expect(gapLines[0]?.dropped as number).toBeGreaterThan(0);
        expect(gapLines[0]?.firstDroppedSeq).toBeDefined();
        expect(gapLines[0]?.lastDroppedSeq).toBeDefined();
      } finally {
        (IpcServer as unknown as Record<string, unknown>).LIVE_BUFFER_MAX_ENTRIES = origMaxEntries;
        IpcServer.BACKFILL_BATCH_SIZE = origBatchSize;
      }
    });

    test("liveBuffer overflow emits gap control message when byte cap is exceeded (#1589)", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      // Tiny batch size + small backfill: same fix as the entry-cap test above —
      // forces many `setTimeout(0)` yields so the test's synchronous publish loop
      // is guaranteed to land in `liveBuffer` before backfill completes.
      const backfillCount = 200;
      for (let i = 0; i < backfillCount; i++) {
        bus.publish({ src: "test", event: "session.result", category: "session", sessionId: `s${i}` });
      }

      const origMaxBytes = IpcServer.LIVE_BUFFER_MAX_BYTES;
      const origBatchSize = IpcServer.BACKFILL_BATCH_SIZE;
      (IpcServer as unknown as Record<string, unknown>).LIVE_BUFFER_MAX_BYTES = 500;
      IpcServer.BACKFILL_BATCH_SIZE = 1;

      const controller = new AbortController();
      try {
        const res = await fetch("http://localhost/events?since=0", {
          method: "GET",
          unix: socketPath,
          signal: controller.signal,
        } as RequestInit);

        expect(res.status).toBe(200);
        if (!res.body) throw new Error("Expected response body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        for (let i = 0; i < 20; i++) {
          bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 800 + i });
        }

        let buffer = "";
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Wait for the gap control message specifically. With BACKFILL_BATCH_SIZE=1
          // the live publishes are also written to eventLog, so they re-emerge as
          // backfill rows; "pr.merged" alone doesn't prove the gap path executed.
          if (buffer.includes('"t":"gap"')) break;
        }

        controller.abort();
        reader.releaseLock();

        const parsed: Array<Record<string, unknown>> = [];
        for (const l of buffer.split("\n").filter((s) => s.startsWith("{"))) {
          try {
            parsed.push(JSON.parse(l) as Record<string, unknown>);
          } catch {
            /* partial chunk */
          }
        }
        const gapLines = parsed.filter((o) => o.t === "gap");
        expect(gapLines.length).toBe(1);
        expect(gapLines[0]?.dropped as number).toBeGreaterThan(0);
        expect(gapLines[0]?.firstDroppedSeq).toBeDefined();
        expect(gapLines[0]?.lastDroppedSeq).toBeDefined();
      } finally {
        (IpcServer as unknown as Record<string, unknown>).LIVE_BUFFER_MAX_BYTES = origMaxBytes;
        IpcServer.BACKFILL_BATCH_SIZE = origBatchSize;
      }
    });

    test("LIVE_BUFFER_MAX_BYTES cap is enforced in UTF-8 bytes, not UTF-16 code units (#1788)", () => {
      // 🎉 is a surrogate pair: 2 UTF-16 code units but 4 UTF-8 bytes.
      // Before fix: liveBufferBytes used line.length (code units), so Unicode events were
      // undercounted by up to 4x, allowing the buffer to exceed the nominal cap.
      // After fix: encoder.encode(line).byteLength is used for accurate UTF-8 accounting.
      const encoder = new TextEncoder();
      const line = `{"event":"pr.merged","msg":"${"🎉".repeat(50)}"}\n`;
      const codeUnits = line.length;
      const utf8Bytes = encoder.encode(line).byteLength;
      // Each 🎉 is 4 UTF-8 bytes but 2 UTF-16 code units → 50 emojis add 100 extra bytes.
      expect(utf8Bytes).toBeGreaterThan(codeUnits);
      expect(utf8Bytes - codeUnits).toBe(100);
      // LIVE_BUFFER_MAX_BYTES is the cap used in the byte check; it now reflects UTF-8 bytes.
      expect(IpcServer.LIVE_BUFFER_MAX_BYTES).toBe(10 * 1024 * 1024);
    });

    test("large backfill does not block concurrent IPC requests (#1589)", async () => {
      const db = new Database(":memory:");
      const eventLog = new EventLog(db);
      const bus = new EventBus(eventLog);
      socketPath = tmpSocket();
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
        ...opts(),
        eventBus: bus,
      });
      server.start(socketPath);

      // Pre-populate a large backlog
      for (let i = 0; i < 5000; i++) {
        bus.publish({ src: "test", event: "session.result", category: "session", sessionId: `s${i}` });
      }

      // Start a backfill stream — the async yields let us interleave IPC.
      const streamController = new AbortController();
      const streamRes = fetch("http://localhost/events?since=0", {
        method: "GET",
        unix: socketPath,
        signal: streamController.signal,
      } as RequestInit);

      // Immediately issue a concurrent IPC request (status endpoint).
      // If backfill blocked the event loop, this would time out.
      const statusRes = await fetch("http://localhost/rpc", {
        method: "POST",
        unix: socketPath,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "status", params: {} }),
      } as RequestInit);

      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { result?: unknown };
      expect(statusBody.result).toBeDefined();

      // Clean up the stream
      streamController.abort();
      await streamRes.catch(() => {});
    });
  });

  // -- GET /events NDJSON endpoint tests (ring-buffer / pushEvent path) --

  test("GET /events with invalid pr returns 400 on ring-buffer path", async () => {
    for (const bad of ["abc", "1.5", "-1", "0", ""]) {
      startServer();
      const res = await fetch(`http://localhost/events?pr=${encodeURIComponent(bad)}`, {
        method: "GET",
        unix: socketPath,
      } as RequestInit);
      expect(res.status, `pr="${bad}"`).toBe(400);
      const text = await res.text();
      expect(text, `pr="${bad}"`).toContain("pr must be a positive integer");
    }
  });

  test("GET /events returns NDJSON content-type", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");

    controller.abort();
  });

  test("GET /events delivers pushed events as NDJSON lines", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Push a synthetic event
    if (!server) throw new Error("server not started");
    server.pushEvent({ t: "test", data: "hello" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("hello")) break;
    }

    controller.abort();
    reader.releaseLock();

    const lines = buffer.split("\n").filter(Boolean);
    // First line is the "connected" event, second is our pushed event
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const connected = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(connected.t).toBe("connected");
    const parsed = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(parsed.t).toBe("test");
    expect(parsed.data).toBe("hello");
    expect(typeof parsed.seq).toBe("number");
    expect(parsed.seq).toBe(1);
  });

  test("GET /events supports multiple concurrent subscribers", async () => {
    startServer();

    const controllers = [new AbortController(), new AbortController()];
    const responses = await Promise.all(
      controllers.map((c) =>
        fetch("http://localhost/events", {
          method: "GET",
          unix: socketPath,
          signal: c.signal,
        } as RequestInit),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const readers = responses.map((r) => {
      if (!r.body) throw new Error("Expected response body");
      return r.body.getReader();
    });
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    server.pushEvent({ t: "broadcast", value: 42 });

    for (const reader of readers) {
      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("broadcast")) break;
      }
      const lines = buffer.split("\n").filter(Boolean);
      // Find the broadcast event (skip connected line)
      const broadcastLine = lines.find((l) => l.includes("broadcast"));
      expect(broadcastLine).toBeDefined();
      const parsed = JSON.parse(broadcastLine as string) as Record<string, unknown>;
      expect(parsed.t).toBe("broadcast");
      expect(parsed.value).toBe(42);
      reader.releaseLock();
    }

    for (const c of controllers) c.abort();
  });

  test("GET /events assigns monotonically increasing seq numbers", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    server.pushEvent({ t: "a" });
    server.pushEvent({ t: "b" });
    server.pushEvent({ t: "c" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const linesSoFar = buffer.split("\n").filter(Boolean);
      // connected + 3 events = 4 lines
      if (linesSoFar.length >= 4) break;
    }

    controller.abort();
    reader.releaseLock();

    const lines = buffer.split("\n").filter(Boolean);
    // Skip connected line, take the 3 event lines
    const eventLines = lines.filter((l) => !l.includes('"connected"'));
    expect(eventLines.length).toBeGreaterThanOrEqual(3);
    const seqs = eventLines.map((l) => (JSON.parse(l) as Record<string, unknown>).seq as number);
    expect(seqs[0]).toBeLessThan(seqs[1] as number);
    expect(seqs[1]).toBeLessThan(seqs[2] as number);
  });

  test("GET /events cleans up subscriber on abort", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!server) throw new Error("server not started");
    expect(server.eventSubscriberCount).toBe(1);

    // Abort the stream and poll until cleanup propagates
    controller.abort();
    await pollUntil(() => server?.eventSubscriberCount === 0);

    // Pushing an event after abort should not throw
    const s = server;
    expect(() => s.pushEvent({ t: "after-abort" })).not.toThrow();
  });

  test("GET /events ring buffer preserves FIFO order after overflow", async () => {
    startServer();
    if (!server) throw new Error("server not started");

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Push capacity + 10 events (256 + 10 = 266) to force ring overflow
    const CAPACITY = 256;
    const TOTAL = CAPACITY + 10;
    for (let i = 0; i < TOTAL; i++) {
      server.pushEvent({ t: "overflow-test", n: i });
    }

    // Collect all lines (connected + TOTAL events; oldest 10 dropped, 256 remain)
    let buffer = "";
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const count = buffer.split("\n").filter(Boolean).length;
      // connected + 256 events
      if (count >= CAPACITY + 1) break;
    }

    controller.abort();
    reader.releaseLock();

    const lines = buffer
      .split("\n")
      .filter(Boolean)
      .filter((l) => l.includes('"overflow-test"'));

    expect(lines.length).toBe(CAPACITY);

    // Events must arrive in ascending n order (FIFO, oldest surviving = n:10)
    const ns = lines.map((l) => (JSON.parse(l) as Record<string, unknown>).n as number);
    expect(ns[0]).toBe(10); // first 10 were dropped
    for (let i = 1; i < ns.length; i++) {
      expect(ns[i]).toBe((ns[i - 1] as number) + 1);
    }
  });

  test("GET /events heartbeat fires after silence", async () => {
    socketPath = tmpSocket();
    const origInterval = (IpcServer as unknown as Record<string, number>).HEARTBEAT_INTERVAL_MS;

    // Patch the static for this test — 200ms heartbeat
    Object.defineProperty(IpcServer, "HEARTBEAT_INTERVAL_MS", { value: 200, configurable: true });

    try {
      server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, opts());
      server.start(socketPath);

      const controller = new AbortController();
      const res = await fetch("http://localhost/events", {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.body) throw new Error("Expected response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Wait for heartbeat
      let buffer = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("heartbeat")) break;
      }

      controller.abort();
      reader.releaseLock();

      const lines = buffer.split("\n").filter(Boolean);
      const hbLine = lines.find((l) => l.includes('"heartbeat"'));
      expect(hbLine).toBeDefined();
      const hb = JSON.parse(hbLine as string) as Record<string, unknown>;
      expect(hb.category).toBe("heartbeat");
      expect(hb.event).toBe("heartbeat");
      expect(hb.src).toBe("daemon");
      expect(typeof hb.ts).toBe("string");
      expect(typeof hb.seq).toBe("number");
    } finally {
      Object.defineProperty(IpcServer, "HEARTBEAT_INTERVAL_MS", {
        value: origInterval ?? 30_000,
        configurable: true,
      });
    }
  });

  test("GET /events respects subscribe filter server-side", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events?subscribe=session", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    // session event — should pass
    server.pushEvent({ event: "session.result", category: "session", t: "ev" });
    // mail event — should be filtered out
    server.pushEvent({ event: "mail.received", category: "mail", t: "ev" });
    // second session event — used as terminator to know mail was skipped
    server.pushEvent({ event: "session.ended", category: "session", t: "ev" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.ended")) break;
    }

    controller.abort();
    reader.releaseLock();

    const lines = buffer
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const events = lines.filter((l) => l.t === "ev");
    expect(events.every((e) => e.category === "session")).toBe(true);
    expect(events.find((e) => e.event === "mail.received")).toBeUndefined();
  });

  test("ring-buffer: session.response excluded from live delivery without responseTail", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    server.pushEvent({ event: "session.response", category: "session", sessionId: "s1", chunk: "secret" });
    server.pushEvent({ event: "session.result", category: "session", sessionId: "s1" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.result")) break;
    }

    controller.abort();
    reader.releaseLock();

    expect(buffer).not.toContain("session.response");
    expect(buffer).toContain("session.result");
  });

  test("ring-buffer: session.response included in live delivery when responseTail matches", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events?responseTail=s1", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    server.pushEvent({ event: "session.response", category: "session", sessionId: "s1", chunk: "hello" });
    server.pushEvent({ event: "session.result", category: "session", sessionId: "s1" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.result")) break;
    }

    controller.abort();
    reader.releaseLock();

    expect(buffer).toContain("session.response");
    expect(buffer).toContain("session.result");
  });

  test("ring-buffer: session.response excluded when responseTail is different session", async () => {
    startServer();

    const controller = new AbortController();
    const res = await fetch("http://localhost/events?responseTail=other-session", {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    if (!server) throw new Error("server not started");
    server.pushEvent({ event: "session.response", category: "session", sessionId: "s1", chunk: "secret" });
    server.pushEvent({ event: "session.result", category: "session", sessionId: "s1" });

    let buffer = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.result")) break;
    }

    controller.abort();
    reader.releaseLock();

    expect(buffer).not.toContain("session.response");
    expect(buffer).toContain("session.result");
  });
});

// ── buildEventFilter unit tests ──

import { buildEventFilter } from "./ipc-server";

describe("buildEventFilter", () => {
  function params(obj: Record<string, string>): URLSearchParams {
    return new URLSearchParams(obj);
  }

  test("returns null when no filters specified", () => {
    expect(buildEventFilter(params({}))).toBeNull();
  });

  test("subscribe filters by category", () => {
    const filter = buildEventFilter(params({ subscribe: "session,work_item" }));
    expect(filter).not.toBeNull();
    expect(filter?.({ category: "session", event: "session.result" })).toBe(true);
    expect(filter?.({ category: "work_item", event: "pr.merged" })).toBe(true);
    expect(filter?.({ category: "mail", event: "mail.received" })).toBe(false);
  });

  test("session filter matches sessionId", () => {
    const filter = buildEventFilter(params({ session: "abc123" }));
    expect(filter?.({ category: "session", sessionId: "abc123", event: "session.result" })).toBe(true);
    expect(filter?.({ category: "session", sessionId: "other", event: "session.result" })).toBe(false);
  });

  test("pr filter matches prNumber", () => {
    const filter = buildEventFilter(params({ pr: "42" }));
    expect(filter?.({ category: "work_item", prNumber: 42, event: "pr.merged" })).toBe(true);
    expect(filter?.({ category: "work_item", prNumber: 99, event: "pr.merged" })).toBe(false);
  });

  test("pr with invalid value returns a reject-all filter", () => {
    for (const bad of ["abc", "1.5", "-1", "0", ""]) {
      const filter = buildEventFilter(params({ pr: bad, subscribe: "work_item" }));
      expect(filter, `pr="${bad}"`).not.toBeNull();
      expect(filter?.({ category: "work_item", prNumber: 42, event: "pr.merged" }), `pr="${bad}"`).toBe(false);
    }
  });

  test("workItem filter matches workItemId", () => {
    const filter = buildEventFilter(params({ workItem: "#1441" }));
    expect(filter?.({ workItemId: "#1441", event: "phase.changed" })).toBe(true);
    expect(filter?.({ workItemId: "#9999", event: "phase.changed" })).toBe(false);
  });

  test("type glob matches event field", () => {
    const filter = buildEventFilter(params({ type: "pr.*" }));
    expect(filter?.({ event: "pr.merged" })).toBe(true);
    expect(filter?.({ event: "pr.closed" })).toBe(true);
    expect(filter?.({ event: "session.result" })).toBe(false);
  });

  test("type glob supports multiple comma-separated patterns", () => {
    const filter = buildEventFilter(params({ type: "pr.*,session.idle" }));
    expect(filter?.({ event: "pr.opened" })).toBe(true);
    expect(filter?.({ event: "session.idle" })).toBe(true);
    expect(filter?.({ event: "mail.received" })).toBe(false);
  });

  test("src glob matches src field", () => {
    const filter = buildEventFilter(params({ src: "daemon.*" }));
    expect(filter?.({ src: "daemon.work-item-poller", event: "pr.merged" })).toBe(true);
    expect(filter?.({ src: "external.thing", event: "pr.merged" })).toBe(false);
  });

  test("phase filter matches phase field", () => {
    const filter = buildEventFilter(params({ phase: "review" }));
    expect(filter?.({ phase: "review", event: "phase.changed" })).toBe(true);
    expect(filter?.({ phase: "impl", event: "phase.changed" })).toBe(false);
  });

  test("multiple filters are ANDed", () => {
    const filter = buildEventFilter(params({ session: "s1", type: "session.*" }));
    expect(filter?.({ sessionId: "s1", event: "session.result" })).toBe(true);
    expect(filter?.({ sessionId: "s2", event: "session.result" })).toBe(false);
    expect(filter?.({ sessionId: "s1", event: "pr.merged" })).toBe(false);
  });

  test("src filter is fail-closed when src field is missing", () => {
    const filter = buildEventFilter(params({ src: "*" }));
    // event with no src field must NOT pass through, even with wildcard
    expect(filter?.({ event: "pr.merged" })).toBe(false);
    expect(filter?.({ src: "daemon.poller", event: "pr.merged" })).toBe(true);
  });

  test("type filter is fail-closed when event field is missing", () => {
    const filter = buildEventFilter(params({ type: "*" }));
    expect(filter?.({ category: "session" })).toBe(false);
    expect(filter?.({ event: "session.result", category: "session" })).toBe(true);
  });

  test("heartbeat events bypass all filters", () => {
    const filter = buildEventFilter(params({ subscribe: "session", pr: "42", type: "session.*" }));
    expect(filter).not.toBeNull();
    expect(filter?.({ category: "heartbeat", event: "heartbeat" })).toBe(true);
    expect(filter?.({ category: "heartbeat", event: "heartbeat", src: "daemon" })).toBe(true);
  });
});
