/**
 * mcx serve — stdio MCP server that proxies tools from the daemon.
 *
 * Two modes that compose:
 *
 * **Curated mode** (MCP_TOOLS is set):
 *   Each entry becomes a top-level MCP tool with its real JSON Schema.
 *   Format: "server/tool" for server tools, "name" for aliases (_aliases/name).
 *
 * **Discovery mode** (always available):
 *   `find` — search/list available tools across all servers
 *   `call` — invoke any tool by server/tool path
 */

import type { IpcMethod, ToolInfo } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// -- Types --

export interface CuratedTool {
  /** Display name (tool name, last segment) */
  name: string;
  server: string;
  tool: string;
}

interface ToolCallResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** Dependency-injectable IPC caller for testing */
export type IpcCaller = (method: IpcMethod, params?: unknown) => Promise<unknown>;

// -- MCP_TOOLS parsing --

/**
 * Parse the MCP_TOOLS env var into a list of curated tools.
 * Format: comma-separated, "server/tool" or "aliasName".
 * Alias names (no slash) resolve to _aliases/<name>.
 * Returns deduplicated list; warns on stderr for name conflicts.
 */
export function parseMcpTools(env: string | undefined): CuratedTool[] {
  if (!env?.trim()) return [];

  const seen = new Map<string, CuratedTool>();
  const results: CuratedTool[] = [];

  for (const raw of env.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;

    const slashIdx = entry.indexOf("/");
    let server: string;
    let tool: string;
    let name: string;

    if (slashIdx >= 0) {
      server = entry.slice(0, slashIdx);
      tool = entry.slice(slashIdx + 1);
      name = tool;
    } else {
      // Alias — resolve as _aliases/<name>
      server = "_aliases";
      tool = entry;
      name = entry;
    }

    if (!server || !tool) continue;

    const existing = seen.get(name);
    if (existing) {
      console.error(
        `[mcx serve] Name conflict: "${name}" from ${server}/${tool} conflicts with ${existing.server}/${existing.tool}. Keeping first.`,
      );
      continue;
    }

    const ct: CuratedTool = { name, server, tool };
    seen.set(name, ct);
    results.push(ct);
  }

  return results;
}

// -- Meta-tool definitions --

export const FIND_TOOL = {
  name: "find",
  description:
    "Search available MCP tools across all connected servers. Returns tool names, servers, and descriptions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: { type: "string", description: "Filter tools by name or description. Omit to list all." },
    },
  },
};

export const CALL_TOOL = {
  name: "call",
  description: "Call any MCP tool by server/tool path. Use 'find' to discover available tools first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      tool: { type: "string", description: "Tool path as 'server/tool'" },
      input: { type: "object", description: "Arguments to pass to the tool" },
    },
    required: ["tool"],
  },
};

// -- Recursion guard --

const MCX_SERVE_GUARD = "MCX_SERVE";

export function checkRecursionGuard(): boolean {
  return process.env[MCX_SERVE_GUARD] === "1";
}

// -- Handler logic (extracted for testability) --

export async function handleListTools(
  curated: CuratedTool[],
  ipc: IpcCaller,
): Promise<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }> {
  const curatedTools = await Promise.all(
    curated.map(async (ct) => {
      try {
        const info = (await ipc("getToolInfo", {
          server: ct.server,
          tool: ct.tool,
        })) as ToolInfo & { inputSchema: Record<string, unknown> };
        return {
          name: ct.name,
          description: info.description ?? "",
          inputSchema: info.inputSchema ?? { type: "object" as const, properties: {} },
        };
      } catch (err) {
        console.error(`[mcx serve] Failed to fetch schema for ${ct.server}/${ct.tool}: ${err}`);
        return {
          name: ct.name,
          description: `(schema unavailable) ${ct.server}/${ct.tool}`,
          inputSchema: { type: "object" as const, properties: {} },
        };
      }
    }),
  );

  return {
    tools: [...curatedTools, FIND_TOOL, CALL_TOOL],
  };
}

export async function handleCallTool(
  name: string,
  args: Record<string, unknown> | undefined,
  curated: CuratedTool[],
  ipc: IpcCaller,
): Promise<ToolCallResult> {
  // Meta-tool: find
  if (name === "find") {
    const q = args?.q as string | undefined;
    const tools = q
      ? ((await ipc("grepTools", { pattern: q })) as ToolInfo[])
      : ((await ipc("listTools")) as ToolInfo[]);
    const lines = tools.map((t) => `${t.server}/${t.name} — ${t.description}`);
    return { content: [{ type: "text", text: lines.join("\n") || "No tools found." }] };
  }

  // Meta-tool: call
  if (name === "call") {
    const toolPath = args?.tool as string | undefined;
    if (!toolPath) {
      return {
        isError: true,
        content: [{ type: "text", text: "Missing required 'tool' argument (format: server/tool)" }],
      };
    }
    const slashIdx = toolPath.indexOf("/");
    if (slashIdx < 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid tool path "${toolPath}". Use "server/tool" format.` }],
      };
    }
    const server = toolPath.slice(0, slashIdx);
    const tool = toolPath.slice(slashIdx + 1);
    const input = (args?.input as Record<string, unknown>) ?? {};
    return (await ipc("callTool", { server, tool, arguments: input })) as ToolCallResult;
  }

  // Curated tool
  const ct = curated.find((c) => c.name === name);
  if (ct) {
    return (await ipc("callTool", {
      server: ct.server,
      tool: ct.tool,
      arguments: args ?? {},
    })) as ToolCallResult;
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

// -- Server --

export async function cmdServe(): Promise<void> {
  if (checkRecursionGuard()) {
    console.error("[mcx serve] Recursion detected (MCX_SERVE=1 already set). Aborting to prevent infinite loop.");
    process.exit(1);
  }
  // Set the guard so any child `mcx serve` spawned by the daemon will detect the loop
  process.env[MCX_SERVE_GUARD] = "1";

  const { ipcCall } = await import("@mcp-cli/core");
  const curated = parseMcpTools(process.env.MCP_TOOLS);

  const server = new Server({ name: "mcx-serve", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => handleListTools(curated, ipcCall));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleCallTool(name, args as Record<string, unknown> | undefined, curated, ipcCall);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcx serve] MCP server running on stdio");
}
