import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ALIAS_SERVER_NAME } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import { _resetJqStateForTesting } from "../jq/index";
import { SERVE_SIZE_OK, SERVE_SIZE_TRUNCATE } from "../jq/jq-support";
import {
  CALL_TOOL,
  type Closeable,
  type CuratedTool,
  FIND_TOOL,
  type IpcCaller,
  type ToolListNotifier,
  checkRecursionGuard,
  checkTtyStdin,
  computeToolsFingerprint,
  handleCallTool,
  handleListTools,
  parseMcpTools,
  registerShutdownHandlers,
  startToolListPoller,
} from "./serve";

// -- parseMcpTools --

describe("parseMcpTools", () => {
  test("returns empty array for undefined", () => {
    expect(parseMcpTools(undefined)).toEqual([]);
  });

  test("returns empty array for empty string", () => {
    expect(parseMcpTools("")).toEqual([]);
  });

  test("returns empty array for whitespace-only", () => {
    expect(parseMcpTools("  ")).toEqual([]);
  });

  test("parses server/tool entries", () => {
    const result = parseMcpTools("atlassian/search,github/create_issue");
    expect(result).toEqual([
      { name: "search", server: "atlassian", tool: "search" },
      { name: "create_issue", server: "github", tool: "create_issue" },
    ]);
  });

  test("parses alias entries (no slash) as _aliases", () => {
    const result = parseMcpTools("deploy-pr,run-tests");
    expect(result).toEqual([
      { name: "deploy-pr", server: ALIAS_SERVER_NAME, tool: "deploy-pr" },
      { name: "run-tests", server: ALIAS_SERVER_NAME, tool: "run-tests" },
    ]);
  });

  test("handles mixed server/tool and alias entries", () => {
    const result = parseMcpTools("atlassian/search,deploy-pr");
    expect(result).toEqual([
      { name: "search", server: "atlassian", tool: "search" },
      { name: "deploy-pr", server: ALIAS_SERVER_NAME, tool: "deploy-pr" },
    ]);
  });

  test("trims whitespace around entries", () => {
    const result = parseMcpTools(" atlassian/search , github/list ");
    expect(result).toEqual([
      { name: "search", server: "atlassian", tool: "search" },
      { name: "list", server: "github", tool: "list" },
    ]);
  });

  test("skips empty entries from extra commas", () => {
    const result = parseMcpTools(",atlassian/search,,github/list,");
    expect(result).toEqual([
      { name: "search", server: "atlassian", tool: "search" },
      { name: "list", server: "github", tool: "list" },
    ]);
  });

  test("deduplicates on tool name, keeps first", () => {
    const result = parseMcpTools("atlassian/search,github/search");
    expect(result).toEqual([{ name: "search", server: "atlassian", tool: "search" }]);
    expect(result).toHaveLength(1);
  });

  test("deduplicates alias vs server/tool with same name", () => {
    const result = parseMcpTools("atlassian/deploy,deploy");
    expect(result).toEqual([{ name: "deploy", server: "atlassian", tool: "deploy" }]);
    expect(result).toHaveLength(1);
  });

  test("handles single entry", () => {
    const result = parseMcpTools("atlassian/search");
    expect(result).toEqual([{ name: "search", server: "atlassian", tool: "search" }]);
  });

  test("skips entries with empty server or tool (bare slash)", () => {
    const result = parseMcpTools("/search,atlassian/,valid/tool");
    expect(result).toEqual([{ name: "tool", server: "valid", tool: "tool" }]);
  });
});

// -- TTY stdin check --

describe("checkTtyStdin", () => {
  test("returns a boolean reflecting Bun.stdin.isTTY", () => {
    const result = checkTtyStdin();
    expect(typeof result).toBe("boolean");
    // In test runner, stdin is typically not a TTY
    expect(result).toBe(!!process.stdin.isTTY);
  });
});

// -- Recursion guard --

describe("checkRecursionGuard", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MCX_SERVE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      process.env.MCX_SERVE = undefined;
    } else {
      process.env.MCX_SERVE = savedEnv;
    }
  });

  test("returns false when MCX_SERVE is not set", () => {
    process.env.MCX_SERVE = undefined;
    expect(checkRecursionGuard()).toBe(false);
  });

  test("returns false when MCX_SERVE is empty", () => {
    process.env.MCX_SERVE = "";
    expect(checkRecursionGuard()).toBe(false);
  });

  test("returns true when MCX_SERVE is '1'", () => {
    process.env.MCX_SERVE = "1";
    expect(checkRecursionGuard()).toBe(true);
  });

  test("returns false when MCX_SERVE is some other value", () => {
    process.env.MCX_SERVE = "yes";
    expect(checkRecursionGuard()).toBe(false);
  });
});

// -- handleListTools --

describe("handleListTools", () => {
  const mockIpc = (async (method: IpcMethod, params?: unknown) => {
    if (method === "getToolInfo") {
      const p = params as { server: string; tool: string };
      return {
        name: p.tool,
        server: p.server,
        description: `Description of ${p.tool}`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      };
    }
    return null;
  }) as IpcCaller;

  test("returns find and call meta-tools when no curated tools", async () => {
    const result = await handleListTools([], mockIpc);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("find");
    expect(result.tools[1].name).toBe("call");
  });

  test("returns curated tools with real schemas + meta-tools", async () => {
    const curated: CuratedTool[] = [{ name: "search", server: "atlassian", tool: "search" }];
    const result = await handleListTools(curated, mockIpc);
    expect(result.tools).toHaveLength(3);
    expect(result.tools[0].name).toBe("search");
    expect(result.tools[0].description).toBe("Description of search");
    expect(result.tools[0].inputSchema).toEqual({
      type: "object",
      properties: {
        q: { type: "string" },
        jq: {
          type: "string",
          description:
            "JQ filter to apply server-side (e.g., '.entities[:5]'). Set to 'false' to bypass size protection.",
        },
      },
    });
    expect(result.tools[1].name).toBe("find");
    expect(result.tools[2].name).toBe("call");
  });

  test("handles schema fetch failure gracefully", async () => {
    const failIpc = (async (_method: IpcMethod) => {
      throw new Error("Connection refused");
    }) as IpcCaller;
    const curated: CuratedTool[] = [{ name: "broken", server: "bad", tool: "broken" }];
    const result = await handleListTools(curated, failIpc);
    expect(result.tools).toHaveLength(3);
    expect(result.tools[0].name).toBe("broken");
    expect(result.tools[0].description).toContain("schema unavailable");
  });
});

// -- handleCallTool --

describe("handleCallTool", () => {
  const mockIpc = (async (method: IpcMethod, params?: unknown) => {
    if (method === "listTools") {
      return [
        { name: "search", server: "atlassian", description: "Search stuff" },
        { name: "echo", server: "test", description: "Echo input" },
      ];
    }
    if (method === "grepTools") {
      const p = params as { pattern: string };
      return [{ name: "search", server: "atlassian", description: `Matched: ${p.pattern}` }];
    }
    if (method === "callTool") {
      const p = params as { server: string; tool: string; arguments: Record<string, unknown> };
      return {
        content: [{ type: "text", text: `Called ${p.server}/${p.tool}` }],
      };
    }
    return null;
  }) as IpcCaller;

  const curated: CuratedTool[] = [{ name: "search", server: "atlassian", tool: "search" }];

  test("find lists all tools when no query", async () => {
    const result = await handleCallTool("find", {}, curated, mockIpc);
    expect(result.content[0].text).toContain("atlassian/search");
    expect(result.content[0].text).toContain("test/echo");
  });

  test("find filters tools with query", async () => {
    const result = await handleCallTool("find", { q: "search" }, curated, mockIpc);
    expect(result.content[0].text).toContain("atlassian/search");
    expect(result.content[0].text).not.toContain("test/echo");
  });

  test("find returns message when no tools found", async () => {
    const emptyIpc = (async (_method: IpcMethod) => []) as IpcCaller;
    const result = await handleCallTool("find", { q: "nonexistent" }, [], emptyIpc);
    expect(result.content[0].text).toBe("No tools found.");
  });

  test("call proxies to ipcCall with correct params", async () => {
    const result = await handleCallTool("call", { tool: "test/echo", input: { msg: "hi" } }, curated, mockIpc);
    expect(result.content[0].text).toBe("Called test/echo");
  });

  test("call errors on missing tool argument", async () => {
    const result = await handleCallTool("call", {}, curated, mockIpc);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing required");
  });

  test("call errors on invalid tool path (no slash)", async () => {
    const result = await handleCallTool("call", { tool: "noslash" }, curated, mockIpc);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("server/tool");
  });

  test("call defaults input to empty object when omitted", async () => {
    let captured: Record<string, unknown> | undefined;
    const capturingIpc = (async (_method: IpcMethod, params?: unknown) => {
      captured = params as Record<string, unknown>;
      return { content: [{ type: "text", text: "ok" }] };
    }) as IpcCaller;
    await handleCallTool("call", { tool: "s/t" }, [], capturingIpc);
    expect((captured as Record<string, unknown>).arguments).toEqual({});
  });

  test("curated tool proxies to correct server/tool", async () => {
    const result = await handleCallTool("search", { query: "test" }, curated, mockIpc);
    expect(result.content[0].text).toBe("Called atlassian/search");
  });

  test("unknown tool returns error", async () => {
    const result = await handleCallTool("nonexistent", {}, curated, mockIpc);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool: nonexistent");
  });

  test("curated tool passes arguments through", async () => {
    let captured: Record<string, unknown> | undefined;
    const capturingIpc = (async (_method: IpcMethod, params?: unknown) => {
      captured = params as Record<string, unknown>;
      return { content: [{ type: "text", text: "ok" }] };
    }) as IpcCaller;
    await handleCallTool("search", { query: "test" }, curated, capturingIpc);
    expect((captured as Record<string, unknown>).arguments).toEqual({ query: "test" });
    expect((captured as Record<string, unknown>).server).toBe("atlassian");
    expect((captured as Record<string, unknown>).tool).toBe("search");
  });
});

// -- Meta-tool schemas --

describe("meta-tool definitions", () => {
  test("FIND_TOOL has expected shape", () => {
    expect(FIND_TOOL.name).toBe("find");
    expect(FIND_TOOL.inputSchema.type).toBe("object");
  });

  test("CALL_TOOL has expected shape", () => {
    expect(CALL_TOOL.name).toBe("call");
    expect(CALL_TOOL.inputSchema.required).toContain("tool");
  });
});

// -- computeToolsFingerprint --

describe("computeToolsFingerprint", () => {
  test("returns consistent hash for same tool list", async () => {
    const ipc = (async () => [
      { name: "search", server: "atlassian", description: "Search" },
      { name: "echo", server: "test", description: "Echo" },
    ]) as IpcCaller;
    const a = await computeToolsFingerprint(ipc);
    const b = await computeToolsFingerprint(ipc);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  test("returns same hash regardless of order", async () => {
    const ipcA = (async () => [
      { name: "search", server: "atlassian", description: "Search" },
      { name: "echo", server: "test", description: "Echo" },
    ]) as IpcCaller;
    const ipcB = (async () => [
      { name: "echo", server: "test", description: "Echo" },
      { name: "search", server: "atlassian", description: "Search" },
    ]) as IpcCaller;
    expect(await computeToolsFingerprint(ipcA)).toBe(await computeToolsFingerprint(ipcB));
  });

  test("returns different hash when tools change", async () => {
    const ipcBefore = (async () => [{ name: "search", server: "atlassian", description: "Search" }]) as IpcCaller;
    const ipcAfter = (async () => [
      { name: "search", server: "atlassian", description: "Search" },
      { name: "echo", server: "test", description: "Echo" },
    ]) as IpcCaller;
    const before = await computeToolsFingerprint(ipcBefore);
    const after = await computeToolsFingerprint(ipcAfter);
    expect(before).not.toBe(after);
  });
});

// -- startToolListPoller --

/**
 * Poll condition until it returns true or deadline passes.
 * Never use a fixed sleep to wait for async side effects — poll instead.
 */
async function pollUntil(condition: () => boolean | undefined | null | number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (!condition()) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

describe("startToolListPoller", () => {
  test("sends notification when tool list changes", async () => {
    let callCount = 0;
    const tools = [
      [{ name: "search", server: "atlassian", description: "Search" }],
      [{ name: "search", server: "atlassian", description: "Search" }],
      [
        { name: "search", server: "atlassian", description: "Search" },
        { name: "echo", server: "test", description: "Echo" },
      ],
    ];
    const ipc = (async () => tools[Math.min(callCount++, tools.length - 1)]) as IpcCaller;

    const notifications: string[] = [];
    const notifier: ToolListNotifier = {
      notification: async (params) => {
        notifications.push(params.method);
      },
    };

    const stop = startToolListPoller(notifier, ipc, 20);
    await pollUntil(() => notifications.length >= 1);
    stop();

    expect(notifications).toEqual(["notifications/tools/list_changed"]);
  });

  test("does not notify when tool list is unchanged", async () => {
    let callCount = 0;
    const ipc = (async () => {
      callCount++;
      return [{ name: "search", server: "atlassian", description: "Search" }];
    }) as IpcCaller;

    const notifications: string[] = [];
    const notifier: ToolListNotifier = {
      notification: async (params) => {
        notifications.push(params.method);
      },
    };

    const stop = startToolListPoller(notifier, ipc, 20);
    // Poll until at least 3 cycles have run, then verify no notifications
    await pollUntil(() => callCount >= 3);
    stop();

    expect(notifications).toEqual([]);
  });

  test("handles IPC errors gracefully without crashing", async () => {
    let callCount = 0;
    const ipc = (async () => {
      callCount++;
      if (callCount === 2) throw new Error("daemon unreachable");
      return [{ name: "search", server: "atlassian", description: "Search" }];
    }) as IpcCaller;

    const notifier: ToolListNotifier = {
      notification: async () => {},
    };

    const stop = startToolListPoller(notifier, ipc, 20);
    await pollUntil(() => callCount >= 3);
    stop();

    // Should have made multiple calls despite the error
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test("cleanup function stops polling", async () => {
    let callCount = 0;
    const ipc = (async () => {
      callCount++;
      return [];
    }) as IpcCaller;

    const notifier: ToolListNotifier = {
      notification: async () => {},
    };

    const stop = startToolListPoller(notifier, ipc, 20);
    await pollUntil(() => callCount >= 2);
    stop();
    const countAtStop = callCount;
    await Bun.sleep(60);

    expect(callCount).toBe(countAtStop);
  });
});

// -- registerShutdownHandlers --

describe("registerShutdownHandlers", () => {
  test("calls close on all closeables when SIGTERM fires", async () => {
    const closed: string[] = [];
    const a: Closeable = {
      close: async () => {
        closed.push("a");
      },
    };
    const b: Closeable = {
      close: async () => {
        closed.push("b");
      },
    };

    const unregister = registerShutdownHandlers([a, b]);
    process.emit("SIGTERM");
    // Allow async handler to complete
    await Bun.sleep(10);

    expect(closed).toEqual(["a", "b"]);
    unregister();
  });

  test("calls close on all closeables when SIGINT fires", async () => {
    const closed: string[] = [];
    const a: Closeable = {
      close: async () => {
        closed.push("a");
      },
    };

    const unregister = registerShutdownHandlers([a]);
    process.emit("SIGINT");
    await Bun.sleep(10);

    expect(closed).toEqual(["a"]);
    unregister();
  });

  test("unregister removes signal handlers (no double-close)", async () => {
    const closed: string[] = [];
    const a: Closeable = {
      close: async () => {
        closed.push("a");
      },
    };

    const unregister = registerShutdownHandlers([a]);
    unregister();

    // Guard: without a listener, process.emit("SIGTERM") triggers default kill behavior.
    // Add a no-op so the signal doesn't terminate the test process.
    const noop = () => {};
    process.once("SIGTERM", noop);
    process.emit("SIGTERM");
    process.off("SIGTERM", noop);
    await Bun.sleep(10);

    expect(closed).toEqual([]);
  });

  test("only fires once per signal (uses process.once)", async () => {
    const closed: string[] = [];
    const a: Closeable = {
      close: async () => {
        closed.push("a");
      },
    };

    const unregister = registerShutdownHandlers([a]);
    process.emit("SIGTERM");
    // After process.once fires, the handler is auto-removed. Guard the second emit
    // with a no-op so the test process isn't killed by an unhandled SIGTERM.
    const noop = () => {};
    process.once("SIGTERM", noop);
    process.emit("SIGTERM");
    process.off("SIGTERM", noop);
    await Bun.sleep(10);

    expect(closed).toEqual(["a"]);
    unregister();
  });
});

// -- Server-side jq support --

describe("handleListTools with jq injection", () => {
  const mockIpc = (async (method: IpcMethod, params?: unknown) => {
    if (method === "getToolInfo") {
      const p = params as { server: string; tool: string };
      return {
        name: p.tool,
        server: p.server,
        description: `Description of ${p.tool}`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      };
    }
    return null;
  }) as IpcCaller;

  test("curated tools have jq parameter injected into schema", async () => {
    const curated: CuratedTool[] = [{ name: "search", server: "atlassian", tool: "search" }];
    const result = await handleListTools(curated, mockIpc);
    const searchTool = result.tools.find((t) => t.name === "search");
    expect(searchTool).toBeDefined();
    const props = searchTool?.inputSchema.properties as Record<string, unknown>;
    expect(props.jq).toBeDefined();
    expect(props.q).toBeDefined(); // original property preserved
  });

  test("meta-tools do not have jq injected", async () => {
    const result = await handleListTools([], mockIpc);
    const findTool = result.tools.find((t) => t.name === "find");
    const callTool = result.tools.find((t) => t.name === "call");
    expect(findTool).toBeDefined();
    expect(callTool).toBeDefined();
    const findProps = findTool?.inputSchema.properties as Record<string, unknown>;
    expect(findProps.jq).toBeUndefined();
  });
});

describe("handleCallTool with jq support", () => {
  afterEach(() => {
    _resetJqStateForTesting();
  });

  const curated: CuratedTool[] = [{ name: "search", server: "atlassian", tool: "search" }];

  test("curated tool strips jq from args before forwarding", async () => {
    let captured: Record<string, unknown> | undefined;
    const capturingIpc = (async (_method: IpcMethod, params?: unknown) => {
      captured = params as Record<string, unknown>;
      return { content: [{ type: "text", text: '{"result": "ok"}' }] };
    }) as IpcCaller;

    await handleCallTool("search", { query: "test", jq: ".result" }, curated, capturingIpc);
    // jq should NOT be forwarded to the upstream tool
    expect((captured as Record<string, unknown>).arguments).toEqual({ query: "test" });
  });

  test("curated tool applies jq filter to JSON response", async () => {
    const mockIpc = (async () => ({
      content: [{ type: "text", text: '{"items": [1, 2, 3], "total": 3}' }],
    })) as IpcCaller;

    const result = await handleCallTool("search", { jq: ".items" }, curated, mockIpc);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  test("curated tool with jq='false' bypasses size protection", async () => {
    const bigData = JSON.stringify({
      records: Array.from({ length: 500 }, (_, i) => ({ id: i, payload: "x".repeat(50) })),
    });
    expect(Buffer.byteLength(bigData)).toBeGreaterThan(SERVE_SIZE_TRUNCATE);

    const mockIpc = (async () => ({
      content: [{ type: "text", text: bigData }],
    })) as IpcCaller;

    const result = await handleCallTool("search", { jq: "false" }, curated, mockIpc);
    expect(result.content[0].text).toBe(bigData);
  });

  test("curated tool applies size protection when no jq specified", async () => {
    const bigData = JSON.stringify({
      records: Array.from({ length: 500 }, (_, i) => ({ id: i, payload: "x".repeat(50) })),
    });
    expect(Buffer.byteLength(bigData)).toBeGreaterThan(SERVE_SIZE_TRUNCATE);

    const mockIpc = (async () => ({
      content: [{ type: "text", text: bigData }],
    })) as IpcCaller;

    const result = await handleCallTool("search", { query: "test" }, curated, mockIpc);
    expect(result.content[0].text).toContain("Response too large");
    expect(result.content[0].text).toContain("jq parameter");
  });

  test("call meta-tool supports jq in input args", async () => {
    const mockIpc = (async (_method: IpcMethod, params?: unknown) => {
      const p = params as { arguments: Record<string, unknown> };
      // Verify jq is stripped before forwarding
      expect(p.arguments).not.toHaveProperty("jq");
      return { content: [{ type: "text", text: '{"data": [1, 2, 3]}' }] };
    }) as IpcCaller;

    const result = await handleCallTool("call", { tool: "test/echo", input: { jq: ".data" } }, [], mockIpc);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  test("small responses pass through without modification", async () => {
    const smallData = '{"status": "ok"}';
    const mockIpc = (async () => ({
      content: [{ type: "text", text: smallData }],
    })) as IpcCaller;

    const result = await handleCallTool("search", {}, curated, mockIpc);
    expect(result.content[0].text).toBe(smallData);
    expect(result.content).toHaveLength(1);
  });
});
