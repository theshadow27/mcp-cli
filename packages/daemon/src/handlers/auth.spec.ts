import { describe, expect, test } from "bun:test";
import { IPC_ERROR } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { AuthHandlers } from "./auth";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockPool(overrides: Record<string, unknown> = {}) {
  return {
    listServers: () => [],
    getServerUrl: () => null,
    getDb: () => null,
    getServerConfig: () => null,
    getCachedTools: () => [],
    callTool: async () => ({ content: [] }),
    listTools: async () => [],
    restart: async () => {},
    ...overrides,
  } as never;
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

function buildHandlers(pool = mockPool()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new AuthHandlers(pool, mockLogger).register(map);
  return map;
}

describe("AuthHandlers – triggerAuth", () => {
  test("throws SERVER_NOT_FOUND when no serverUrl and no auth tool", async () => {
    const map = buildHandlers(
      mockPool({
        getServerUrl: () => null,
        listTools: async () => [{ name: "search", description: "" }],
      }),
    );
    const err = await invoke(map, "triggerAuth")({ server: "myserver" }, {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(IPC_ERROR.SERVER_NOT_FOUND);
  });

  test("calls callTool('auth') when no serverUrl but has auth tool", async () => {
    let calledWith: unknown;
    const map = buildHandlers(
      mockPool({
        getServerUrl: () => null,
        listTools: async () => [{ name: "auth", description: "" }],
        callTool: async (server: string, tool: string, args: unknown) => {
          calledWith = { server, tool, args };
          return { content: [{ type: "text", text: "authenticated" }], isError: false };
        },
      }),
    );
    const result = (await invoke(map, "triggerAuth")({ server: "myserver" }, {} as never)) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(true);
    expect(result.message).toBe("authenticated");
    expect((calledWith as { tool: string }).tool).toBe("auth");
  });

  test("throws INTERNAL_ERROR when auth tool returns isError=true", async () => {
    const map = buildHandlers(
      mockPool({
        getServerUrl: () => null,
        listTools: async () => [{ name: "auth", description: "" }],
        callTool: async () => ({ content: [{ type: "text", text: "bad creds" }], isError: true }),
      }),
    );
    const err = await invoke(map, "triggerAuth")({ server: "myserver" }, {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(IPC_ERROR.INTERNAL_ERROR);
  });
});

describe("AuthHandlers – authStatus", () => {
  test("returns all servers when no server filter", async () => {
    const map = buildHandlers(
      mockPool({
        listServers: () => [
          { name: "s1", transport: "stdio", toolCount: 0 },
          { name: "s2", transport: "stdio", toolCount: 0 },
        ],
        getServerUrl: () => null,
        getCachedTools: () => [],
      }),
    );
    const result = (await invoke(map, "authStatus")(undefined, {} as never)) as { servers: { server: string }[] };
    expect(result.servers).toHaveLength(2);
    expect(result.servers.map((s) => s.server)).toEqual(["s1", "s2"]);
  });

  test("throws SERVER_NOT_FOUND for unknown server", async () => {
    const map = buildHandlers(
      mockPool({
        listServers: () => [{ name: "s1", transport: "stdio", toolCount: 0 }],
      }),
    );
    const err = await invoke(map, "authStatus")({ server: "unknown" }, {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(IPC_ERROR.SERVER_NOT_FOUND);
  });

  test("returns auth_tool support for stdio server with auth tool cached", async () => {
    const map = buildHandlers(
      mockPool({
        listServers: () => [{ name: "s1", transport: "stdio", toolCount: 1 }],
        getServerUrl: () => null,
        getCachedTools: () => [{ name: "auth", description: "" }],
      }),
    );
    const result = (await invoke(map, "authStatus")({ server: "s1" }, {} as never)) as {
      servers: { server: string; authSupport: string; status: string }[];
    };
    expect(result.servers[0].authSupport).toBe("auth_tool");
    expect(result.servers[0].status).toBe("unknown");
  });

  test("returns none authSupport for stdio server without auth tool", async () => {
    const map = buildHandlers(
      mockPool({
        listServers: () => [{ name: "s1", transport: "stdio", toolCount: 1 }],
        getServerUrl: () => null,
        getCachedTools: () => [{ name: "search", description: "" }],
      }),
    );
    const result = (await invoke(map, "authStatus")({ server: "s1" }, {} as never)) as {
      servers: { authSupport: string }[];
    };
    expect(result.servers[0].authSupport).toBe("none");
  });
});
