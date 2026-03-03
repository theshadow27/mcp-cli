import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcResponse } from "@mcp-cli/core";
import { IPC_ERROR } from "@mcp-cli/core";
import { IpcServer } from "./ipc-server.js";

/** Unique socket path per test run to avoid conflicts */
function tmpSocket(): string {
  return join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

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

function mockDb() {
  return {
    recordUsage: () => {},
    listAliases: () => [],
    getAlias: () => null,
    saveAlias: () => {},
    deleteAlias: () => {},
    getServerLogs: () => [],
    getCachedTools: () => [],
  } as never;
}

function mockConfig() {
  return {
    servers: new Map(),
    sources: [],
  } as never;
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
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), {
      onActivity: () => {},
    });
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

  test("triggerAuth with server found but no db returns INTERNAL_ERROR", async () => {
    socketPath = tmpSocket();
    const pool = Object.assign(mockPool(), {
      getServerUrl: (name: string) => (name === "myserver" ? "https://example.com" : null),
      getDb: () => null,
    });
    server = new IpcServer(pool as never, mockConfig(), mockDb(), {
      onActivity: () => {},
    });
    server.start(socketPath);

    const res = await rpc("/rpc", { id: "auth2", method: "triggerAuth", params: { server: "myserver" } });
    expect(res.status).toBe(200);

    const json = (await res.json()) as IpcResponse;
    expect(json.id).toBe("auth2");
    expect(json.error?.code).toBe(IPC_ERROR.INTERNAL_ERROR);
    expect(json.error?.message).toContain("Database not available");
  });
});
