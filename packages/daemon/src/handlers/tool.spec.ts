import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { ToolHandlers } from "./tool";

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
    getToolInfo: async (server: string, tool: string) => ({ server, name: tool, description: "", inputSchema: {} }),
    grepTools: async () => [],
    restart: async () => {},
    ...overrides,
  } as never;
}

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    getNote: () => null,
    listNotes: () => [],
    recordUsage: () => {},
    recordSpan: () => {},
    ...overrides,
  } as never;
}

function mockAliasServer(overrides: Record<string, unknown> = {}) {
  return {
    callToolWithChain: async () => ({ content: [] }),
    ...overrides,
  } as never;
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

function mockCtx() {
  return {
    span: {
      child: () => ({
        setAttribute: () => {},
        setStatus: () => {},
        end: () => ({ durationMs: 10, traceId: "abc", parentSpanId: null }),
      }),
    },
  } as never;
}

function buildHandlers(
  pool = mockPool(),
  db = mockDb(),
  aliasServer = mockAliasServer(),
): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new ToolHandlers(pool, db, aliasServer, "daemon-1").register(map);
  return map;
}

describe("ToolHandlers – listTools", () => {
  test("delegates to pool.listTools", async () => {
    const tools = [{ server: "s1", name: "search", description: "search it", inputSchema: {} }];
    const map = buildHandlers(mockPool({ listTools: async () => tools }));
    const result = await invoke(map, "listTools")(undefined, {} as never);
    expect(result).toEqual(tools);
  });

  test("passes server filter to pool", async () => {
    let receivedServer: unknown;
    const map = buildHandlers(
      mockPool({
        listTools: async (server: unknown) => {
          receivedServer = server;
          return [];
        },
      }),
    );
    await invoke(map, "listTools")({ server: "myserver" }, {} as never);
    expect(receivedServer).toBe("myserver");
  });
});

describe("ToolHandlers – getToolInfo", () => {
  test("returns tool info without note when db has no note", async () => {
    const info = { server: "s1", name: "search", description: "search it", inputSchema: {} };
    const map = buildHandlers(mockPool({ getToolInfo: async () => info }), mockDb({ getNote: () => null }));
    const result = await invoke(map, "getToolInfo")({ server: "s1", tool: "search" }, {} as never);
    expect(result).toEqual(info);
  });

  test("enriches result with note from db", async () => {
    const info = { server: "s1", name: "search", description: "search it", inputSchema: {} };
    const map = buildHandlers(mockPool({ getToolInfo: async () => info }), mockDb({ getNote: () => "my note" }));
    const result = (await invoke(map, "getToolInfo")({ server: "s1", tool: "search" }, {} as never)) as {
      note?: string;
    };
    expect(result.note).toBe("my note");
  });
});

describe("ToolHandlers – grepTools", () => {
  test("returns matched tools enriched with notes from db", async () => {
    const tools = [{ server: "s1", name: "search", description: "search it", inputSchema: {} }];
    const notes = [{ serverName: "s1", toolName: "search", note: "useful" }];
    const map = buildHandlers(
      mockPool({ grepTools: async () => tools }),
      mockDb({ listNotes: () => notes, getNote: () => null }),
    );
    const result = (await invoke(map, "grepTools")({ pattern: "search" }, {} as never)) as { note?: string }[];
    expect(result[0].note).toBe("useful");
  });

  test("returns empty array when no tools match", async () => {
    const map = buildHandlers(mockPool({ grepTools: async () => [] }));
    const result = (await invoke(map, "grepTools")({ pattern: "nomatch" }, {} as never)) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("note-matched tools are fetched and included in results", async () => {
    const notes = [{ serverName: "s2", toolName: "deploy", note: "deploys to prod" }];
    const extraInfo = { server: "s2", name: "deploy", description: "", inputSchema: {} };
    const map = buildHandlers(
      mockPool({
        grepTools: async () => [],
        getToolInfo: async () => extraInfo,
      }),
      mockDb({ listNotes: () => notes, getNote: () => null }),
    );
    const result = (await invoke(map, "grepTools")({ pattern: "prod" }, {} as never)) as {
      name: string;
      note: string;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deploy");
    expect(result[0].note).toBe("deploys to prod");
  });
});

describe("ToolHandlers – callTool", () => {
  test("records usage on success", async () => {
    let usageRecorded = false;
    const map = buildHandlers(
      mockPool({ callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      mockDb({
        recordUsage: () => {
          usageRecorded = true;
        },
        recordSpan: () => {},
      }),
    );
    const result = (await invoke(map, "callTool")(
      { server: "s1", tool: "search", arguments: { q: "test" } },
      mockCtx(),
    )) as { content: unknown[] };
    expect(result.content).toHaveLength(1);
    expect(usageRecorded).toBe(true);
  });

  test("records usage and rethrows on failure", async () => {
    let usageRecorded = false;
    const map = buildHandlers(
      mockPool({
        callTool: async () => {
          throw new Error("tool failed");
        },
      }),
      mockDb({
        recordUsage: () => {
          usageRecorded = true;
        },
        recordSpan: () => {},
      }),
    );
    const err = await invoke(map, "callTool")({ server: "s1", tool: "search", arguments: {} }, mockCtx()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("tool failed");
    expect(usageRecorded).toBe(true);
  });
});

describe("ToolHandlers – restartServer", () => {
  test("calls pool.restart and returns ok", async () => {
    let restartedServer: string | undefined;
    const map = buildHandlers(
      mockPool({
        restart: async (server: string) => {
          restartedServer = server;
        },
      }),
    );
    const result = (await invoke(map, "restartServer")({ server: "s1" }, {} as never)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(restartedServer).toBe("s1");
  });
});
