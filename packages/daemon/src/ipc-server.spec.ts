import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcResponse } from "@mcp-cli/core";
import { IPC_ERROR, PROTOCOL_VERSION, options } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { installDaemonLogCapture } from "./daemon-log";
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
    getServerLogs: () => [],
    getCachedTools: () => [],
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
}) {
  return { daemonId: TEST_DAEMON_ID, startedAt: TEST_STARTED_AT, onActivity: () => {}, ...overrides };
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

  test("POST /rpc with ping returns result", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "t1", method: "ping" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("t1");
    expect(json.result).toHaveProperty("pong", true);
    expect(json.result).toHaveProperty("time");
    expect(json.error).toBeUndefined();
  });

  test("socket file has 0600 permissions after start", () => {
    startServer();

    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("ping response includes protocolVersion", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "pv1", method: "ping" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const result = json.result as { pong: boolean; time: number; protocolVersion: string };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("status response includes protocolVersion", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "pv2", method: "status" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const result = json.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("POST /rpc with invalid JSON returns 400", async () => {
    startServer();

    const res = await fetch("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
      unix: socketPath,
    } as RequestInit);

    expect(res.status).toBe(400);
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.PARSE_ERROR);
  });

  test("GET /rpc returns 405", async () => {
    startServer();

    const res = await rpc("/rpc", undefined, "GET");
    expect(res.status).toBe(405);
  });

  test("POST /other returns 404", async () => {
    startServer();

    const res = await rpc("/other", { id: "t2", method: "ping" });
    expect(res.status).toBe(404);
  });

  test("unknown method returns error in body", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "t3", method: "nonExistentMethod" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("t3");
    expect(json.error?.code).toBe(IPC_ERROR.METHOD_NOT_FOUND);
  });

  test("large payload round-trips correctly", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "t4", method: "listServers" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("t4");
    expect(json.result).toEqual([]);
  });

  test("concurrent requests are isolated", async () => {
    startServer();

    const requests = Array.from({ length: 10 }, (_, i) =>
      rpc("/rpc", { id: `c${i}`, method: "ping" }).then((res) => res.json() as Promise<IpcResponse>),
    );

    const results = await Promise.all(requests);
    for (let i = 0; i < 10; i++) {
      expect(results[i].id).toBe(`c${i}`);
      expect(results[i].result).toHaveProperty("pong", true);
    }
  });

  test("triggerAuth with unknown server returns SERVER_NOT_FOUND error", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "auth1", method: "triggerAuth", params: { server: "nonexistent" } });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth1");
    expect(json.error?.code).toBe(IPC_ERROR.SERVER_NOT_FOUND);
    expect(json.error?.message).toContain("nonexistent");
  });

  test("getDaemonLogs returns captured log lines", async () => {
    startServer();

    // Emit a recognizable log line via console.error (captured by daemon-log)
    const marker = `ipc-test-${Date.now()}`;
    console.error(marker);

    const res = await rpc("/rpc", { id: "dl1", method: "getDaemonLogs", params: { limit: 5 } });
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
    startServer();

    const before = Date.now();
    // Small delay to ensure timestamp separation
    await Bun.sleep(5);
    const marker = `since-test-${Date.now()}`;
    console.error(marker);

    const res = await rpc("/rpc", {
      id: "dl2",
      method: "getDaemonLogs",
      params: { since: before },
    });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    const lines = (json.result as { lines: { timestamp: number; line: string }[] }).lines;

    // All returned lines should be after 'before'
    for (const l of lines) {
      expect(l.timestamp).toBeGreaterThan(before);
    }
    // Our marker should be present
    expect(lines.find((l) => l.line === marker)).toBeDefined();
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

  test("status response includes usageStats field", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "us1", method: "status" });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("us1");

    const result = json.result as { usageStats: unknown[] };
    expect(Array.isArray(result.usageStats)).toBe(true);
    expect(result.usageStats).toEqual([]);
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

  // -- Parameter validation tests --

  test("callTool with missing server param returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "v1", method: "callTool", params: { tool: "t" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("Invalid params");
    expect(json.error?.message).toContain("server");
  });

  test("getToolInfo with missing tool param returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "v2", method: "getToolInfo", params: { server: "s" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("Invalid params");
    expect(json.error?.message).toContain("tool");
  });

  test("saveAlias with missing name param returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "v3", method: "saveAlias", params: { script: "x" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("Invalid params");
    expect(json.error?.message).toContain("name");
  });

  test("getLogs with non-number limit returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "v4", method: "getLogs", params: { server: "s", limit: "abc" } });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("Invalid params");
    expect(json.error?.message).toContain("limit");
  });

  test("grepTools with no params returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "v5", method: "grepTools", params: {} });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
    expect(json.error?.message).toContain("pattern");
  });

  test("callTool with valid params still works", async () => {
    startServer();

    const res = await rpc("/rpc", {
      id: "v6",
      method: "callTool",
      params: { server: "s", tool: "t", arguments: { key: "val" } },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toHaveProperty("content");
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

  test("sendMail with missing sender returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", {
      id: "m2",
      method: "sendMail",
      params: { recipient: "manager" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
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
    await Bun.sleep(100);

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

  test("markRead with missing id returns INVALID_PARAMS", async () => {
    startServer();

    const res = await rpc("/rpc", { id: "m10", method: "markRead", params: {} });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INVALID_PARAMS);
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

  test("getAlias returns null for unknown alias", async () => {
    startServer();

    const res = await rpc("/rpc", {
      id: "ga2",
      method: "getAlias",
      params: { name: "nonexistent" },
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error).toBeUndefined();
    expect(json.result).toBeNull();
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

  test("reloadConfig returns INTERNAL_ERROR when no callback configured", async () => {
    startServer();

    const res = await rpc("/rpc", {
      id: "rl2",
      method: "reloadConfig",
    });
    const json = (await res.json()) as IpcResponse;
    expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
    expect(json.error?.message).toContain("Config reload not available");
  });
});
