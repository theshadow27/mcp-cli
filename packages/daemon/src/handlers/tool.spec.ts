import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import { DOMAIN_META_KEY } from "../domain-scope";
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
        traceparent: () => "00-abc-def-01",
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

describe("ToolHandlers – callTool domain scoping (#3039)", () => {
  const PHOENIX = { id: 4, name: "phoenix", host: null, path: "/home/u/phoenix", createdAt: "2026-08-22T00:00:00Z" };

  /** Captures the args that actually reach the worker via the pool. */
  function capturing(dbOverrides: Record<string, unknown> = {}) {
    let forwarded: Record<string, unknown> | undefined;
    const map = buildHandlers(
      mockPool({
        callTool: async (_s: unknown, _t: unknown, args: Record<string, unknown>) => {
          forwarded = args;
          return { content: [] };
        },
      }),
      mockDb({
        getDomainByName: (name: string) => (name === "phoenix" ? PHOENIX : null),
        resolveDomain: (path: string) =>
          path === PHOENIX.path || path.startsWith(`${PHOENIX.path}/`) ? PHOENIX : null,
        ...dbOverrides,
      }),
    );
    return { map, forwarded: () => forwarded };
  }

  test("a named domain becomes a numeric domainId, and the name never reaches the worker", async () => {
    const { map, forwarded } = capturing();
    await invoke(map, "callTool")(
      { server: "_claude", tool: "claude_session_list", arguments: { domain: "phoenix" } },
      mockCtx(),
    );
    expect(forwarded()?.domainId).toBe(PHOENIX.id);
    expect(forwarded()).not.toHaveProperty("domain");
  });

  test("domainCwd resolves to the owning domain", async () => {
    const { map, forwarded } = capturing();
    await invoke(map, "callTool")(
      { server: "_codex", tool: "codex_session_list", arguments: { domainCwd: "/home/u/phoenix/wt" } },
      mockCtx(),
    );
    expect(forwarded()?.domainId).toBe(PHOENIX.id);
    expect(forwarded()).not.toHaveProperty("domainCwd");
  });

  test("--all (no scoping argument) forwards no domain filter at all", async () => {
    const { map, forwarded } = capturing();
    await invoke(map, "callTool")({ server: "_claude", tool: "claude_session_list", arguments: {} }, mockCtx());
    expect(forwarded()).not.toHaveProperty("domainId");
  });

  test("a spawn records the domain of its cwd for every provider", async () => {
    for (const [server, tool] of [
      ["_claude", "claude_prompt"],
      ["_codex", "codex_prompt"],
      ["_acp", "acp_prompt"],
      ["_opencode", "opencode_prompt"],
      ["_mock", "mock_prompt"],
    ] as const) {
      const { map, forwarded } = capturing();
      await invoke(map, "callTool")({ server, tool, arguments: { prompt: "hi", cwd: "/home/u/phoenix" } }, mockCtx());
      expect(forwarded()?.domainId).toBe(PHOENIX.id);
    }
  });

  test("wait is scoped too, for every provider — not just session_list", async () => {
    // The review found `wait` resolved and forwarded a filter that four of five workers
    // discarded. This covers the injection half for every provider; the enforcement
    // half is session-domain-roundtrip.spec.ts plus the session-wait-domain-scoped rule.
    for (const [server, tool] of [
      ["_claude", "claude_wait"],
      ["_codex", "codex_wait"],
      ["_acp", "acp_wait"],
      ["_opencode", "opencode_wait"],
      ["_mock", "mock_wait"],
    ] as const) {
      const { map, forwarded } = capturing();
      await invoke(map, "callTool")(
        { server, tool, arguments: { domainCwd: "/home/u/phoenix/wt", timeout: 10 } },
        mockCtx(),
      );
      expect(forwarded()?.domainId).toBe(PHOENIX.id);
      expect(forwarded()).not.toHaveProperty("domainCwd");
    }
  });

  test("a caller-supplied domainId never reaches a worker", async () => {
    const { map, forwarded } = capturing();
    await invoke(map, "callTool")(
      { server: "_claude", tool: "claude_session_list", arguments: { domainId: 4242 } },
      mockCtx(),
    );
    expect(forwarded()).not.toHaveProperty("domainId");
  });

  test("an unregistered domain name fails the call instead of listing another domain", async () => {
    const { map } = capturing();
    await expect(
      invoke(map, "callTool")(
        { server: "_claude", tool: "claude_session_list", arguments: { domain: "nope" } },
        mockCtx(),
      ),
    ).rejects.toThrow(/unknown domain "nope"/);
  });

  test("claude still gets its traceparent alongside the resolved domain", async () => {
    const { map, forwarded } = capturing();
    await invoke(map, "callTool")(
      { server: "_claude", tool: "claude_prompt", arguments: { prompt: "hi", cwd: "/home/u/phoenix" } },
      mockCtx(),
    );
    expect(forwarded()?.domainId).toBe(PHOENIX.id);
    expect(forwarded()).toHaveProperty("__traceparent");
  });
});

/**
 * The domain a `_work_items` call is scoped to is decided HERE, from the caller's cwd, and
 * travels in MCP `_meta`. These tests pin that it never comes from `arguments` — the
 * property epic C calls reflexive containment and epic D's `_cards` server will reuse.
 */
describe("ToolHandlers – domain scoping of virtual servers", () => {
  const ALPHA = { id: 1, name: "alpha", host: null, path: "/home/u/alpha", createdAt: "2026-08-22T00:00:00.000Z" };

  function captureMeta(overrides: Record<string, unknown> = {}) {
    const seen: { meta?: Record<string, unknown> } = {};
    const pool = mockPool({
      callTool: async (_s: string, _t: string, _a: unknown, _ms: number, opts: { meta?: Record<string, unknown> }) => {
        seen.meta = opts?.meta;
        return { content: [] };
      },
    });
    const db = mockDb({
      resolveDomain: (path: string) => (path?.startsWith("/home/u/alpha") ? ALPHA : null),
      ...overrides,
    });
    return { map: buildHandlers(pool, db), seen };
  }

  test("_work_items receives the domain resolved from the caller's cwd", async () => {
    const { map, seen } = captureMeta();
    await invoke(map, "callTool")(
      { server: "_work_items", tool: "work_items_list", arguments: {}, cwd: "/home/u/alpha/src" },
      mockCtx(),
    );
    expect(seen.meta?.[DOMAIN_META_KEY]).toEqual({ id: 1, name: "alpha" });
  });

  test("a domain named in `arguments` is ignored — the cwd decides", async () => {
    const { map, seen } = captureMeta();
    await invoke(map, "callTool")(
      {
        server: "_work_items",
        tool: "work_items_list",
        arguments: { domainId: 99, domain: "somebody-elses" },
        cwd: "/var/tmp/outside",
      },
      mockCtx(),
    );
    // Outside every domain → the unassigned partition, not the id the caller asked for.
    expect(seen.meta?.[DOMAIN_META_KEY]).toEqual({ id: 0, name: null });
  });

  test("a third-party server gets no mcx routing metadata at all", async () => {
    const { map, seen } = captureMeta();
    await invoke(map, "callTool")(
      { server: "atlassian", tool: "search", arguments: {}, cwd: "/home/u/alpha" },
      mockCtx(),
    );
    expect(seen.meta).toBeUndefined();
  });
});
