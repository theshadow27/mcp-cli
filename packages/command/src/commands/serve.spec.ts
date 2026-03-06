import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import {
  CALL_TOOL,
  type CuratedTool,
  FIND_TOOL,
  type IpcCaller,
  checkRecursionGuard,
  handleCallTool,
  handleListTools,
  parseMcpTools,
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
      { name: "deploy-pr", server: "_aliases", tool: "deploy-pr" },
      { name: "run-tests", server: "_aliases", tool: "run-tests" },
    ]);
  });

  test("handles mixed server/tool and alias entries", () => {
    const result = parseMcpTools("atlassian/search,deploy-pr");
    expect(result).toEqual([
      { name: "search", server: "atlassian", tool: "search" },
      { name: "deploy-pr", server: "_aliases", tool: "deploy-pr" },
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
  const mockIpc: IpcCaller = async (method: IpcMethod, params?: unknown) => {
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
  };

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
    expect(result.tools[0].inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(result.tools[1].name).toBe("find");
    expect(result.tools[2].name).toBe("call");
  });

  test("handles schema fetch failure gracefully", async () => {
    const failIpc: IpcCaller = async (_method: IpcMethod) => {
      throw new Error("Connection refused");
    };
    const curated: CuratedTool[] = [{ name: "broken", server: "bad", tool: "broken" }];
    const result = await handleListTools(curated, failIpc);
    expect(result.tools).toHaveLength(3);
    expect(result.tools[0].name).toBe("broken");
    expect(result.tools[0].description).toContain("schema unavailable");
  });
});

// -- handleCallTool --

describe("handleCallTool", () => {
  const mockIpc: IpcCaller = async (method: IpcMethod, params?: unknown) => {
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
  };

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
    const emptyIpc: IpcCaller = async (_method: IpcMethod) => [];
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
    const capturingIpc: IpcCaller = async (_method: IpcMethod, params?: unknown) => {
      captured = params as Record<string, unknown>;
      return { content: [{ type: "text", text: "ok" }] };
    };
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
    const capturingIpc: IpcCaller = async (_method: IpcMethod, params?: unknown) => {
      captured = params as Record<string, unknown>;
      return { content: [{ type: "text", text: "ok" }] };
    };
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
