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

import { ALIAS_SERVER_NAME } from "@mcp-cli/core";
import type { IpcMethod, ToolInfo } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BunStdioServerTransport } from "../bun-stdio-transport";
import { extractJqArg, injectJqParam, processJqResult } from "../jq/jq-support";
import { splitServerTool } from "../parse";

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
import type { IpcMethodResult } from "@mcp-cli/core";
export type IpcCaller = <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;

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

    const split = splitServerTool(entry);
    let server: string;
    let tool: string;
    let name: string;

    if (split) {
      [server, tool] = split;
      name = tool;
    } else if (!entry.includes("/")) {
      // Alias — resolve as _aliases/<name>
      server = ALIAS_SERVER_NAME;
      tool = entry;
      name = entry;
    } else {
      // Malformed slash entry (e.g. "/tool" or "server/") — skip
      continue;
    }

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
      input: {
        type: "object",
        description:
          "Arguments to pass to the tool. Include a 'jq' key with a filter string to apply server-side filtering.",
      },
    },
    required: ["tool"],
  },
};

// -- Recursion guard --

const MCX_SERVE_GUARD = "MCX_SERVE";

export function checkRecursionGuard(): boolean {
  return process.env[MCX_SERVE_GUARD] === "1";
}

// -- Tool list change detection --

const POLL_INTERVAL_MS = 5_000;

/**
 * Compute a fingerprint of the current tool list from the daemon.
 * Uses sorted server/name pairs so the result is order-independent.
 */
export async function computeToolsFingerprint(ipc: IpcCaller): Promise<string> {
  const tools = await ipc("listTools");
  const key = tools
    .map((t) => `${t.server}/${t.name}`)
    .sort()
    .join("\n");
  const hash = new Bun.CryptoHasher("md5");
  hash.update(key);
  return hash.digest("hex");
}

/** Notifier interface for sending MCP notifications (matches MCP SDK Server). */
export interface ToolListNotifier {
  notification(params: { method: string }): Promise<void>;
}

/**
 * Poll the daemon for tool list changes and send `tools/list_changed` notification.
 * Returns a cleanup function that stops the polling.
 */
export function startToolListPoller(
  notifier: ToolListNotifier,
  ipc: IpcCaller,
  intervalMs = POLL_INTERVAL_MS,
): () => void {
  let previousFingerprint: string | undefined;

  const timer = setInterval(async () => {
    try {
      const fingerprint = await computeToolsFingerprint(ipc);
      if (previousFingerprint === undefined) {
        previousFingerprint = fingerprint;
        return;
      }
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        console.error("[mcx serve] Tool list changed, notifying client");
        await notifier.notification({ method: "notifications/tools/list_changed" });
      }
    } catch (err) {
      console.error(`[mcx serve] Tool list poll failed: ${err}`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
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
          inputSchema: injectJqParam(info.inputSchema ?? { type: "object" as const, properties: {} }),
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
    const tools = q ? await ipc("grepTools", { pattern: q }) : await ipc("listTools");
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
    const split = splitServerTool(toolPath);
    if (!split) {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid tool path "${toolPath}". Use "server/tool" format.` }],
      };
    }
    const [server, tool] = split;
    const input = (args?.input as Record<string, unknown>) ?? {};
    const { jqFilter, cleanArgs: cleanInput } = extractJqArg(input);
    const result = (await ipc("callTool", { server, tool, arguments: cleanInput })) as ToolCallResult;
    return processJqResult(result, jqFilter);
  }

  // Curated tool
  const ct = curated.find((c) => c.name === name);
  if (ct) {
    const { jqFilter, cleanArgs } = extractJqArg(args ?? {});
    const result = (await ipc("callTool", {
      server: ct.server,
      tool: ct.tool,
      arguments: cleanArgs,
    })) as ToolCallResult;
    return processJqResult(result, jqFilter);
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

// -- Graceful shutdown --

/** Something that can be closed (MCP Server, Transport, etc.) */
export interface Closeable {
  close(): Promise<void>;
}

/**
 * Register SIGTERM/SIGINT handlers that gracefully close the given resources.
 * Returns an unregister function that removes the signal handlers.
 */
export function registerShutdownHandlers(closeables: Closeable[]): () => void {
  const shutdown = async () => {
    for (const c of closeables) await c.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };
}

// -- Server --

export function checkTtyStdin(): boolean {
  return !!process.stdin.isTTY;
}

export async function cmdServe(): Promise<void> {
  if (checkTtyStdin()) {
    console.error("[mcx serve] Error: mcx serve is an MCP stdio server — connect it via stdio, not a terminal.");
    console.error("[mcx serve] Example: claude mcp add my-server -- mcx serve");
    process.exit(1);
  }

  if (checkRecursionGuard()) {
    console.error("[mcx serve] Recursion detected (MCX_SERVE=1 already set). Aborting to prevent infinite loop.");
    process.exit(1);
  }
  // Set the guard so any child `mcx serve` spawned by the daemon will detect the loop
  process.env[MCX_SERVE_GUARD] = "1";

  const { ipcCall } = await import("@mcp-cli/core");
  const curated = parseMcpTools(process.env.MCP_TOOLS);

  const server = new Server(
    { name: "mcx-serve", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => handleListTools(curated, ipcCall));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleCallTool(name, args as Record<string, unknown> | undefined, curated, ipcCall);
  });

  const transport = new BunStdioServerTransport();
  await server.connect(transport);
  const stopPoller = startToolListPoller(server, ipcCall);
  console.error("[mcx serve] MCP server running on stdio");

  // Graceful shutdown on SIGTERM/SIGINT — close server and transport so
  // inflight MCP requests get proper responses before the process exits.
  const unregisterShutdown = registerShutdownHandlers([server, transport]);

  // Block until stdin closes — prevents main() from calling process.exit()
  await transport.closed;
  stopPoller();
  unregisterShutdown();
}
