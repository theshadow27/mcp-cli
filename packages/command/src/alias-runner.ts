/**
 * Alias runner — executes TypeScript alias scripts via Bun's virtual module system.
 *
 * Registers a virtual "mcp-cli" module that provides:
 * - `mcp`: Proxy object routing calls through the daemon's IPC (mcp.server.tool(args))
 * - `args`: CLI --key value pairs as Record<string, string>
 * - `file(path)`: Read a file as text
 * - `json(path)`: Read and parse a JSON file
 */

import { resolve } from "node:path";
import { ALIASES_DIR, ipcCall } from "@mcp-cli/core";
import { plugin } from "bun";

type ToolFn = (args?: Record<string, unknown>) => Promise<unknown>;
type ServerProxy = Record<string, ToolFn>;
type McpProxy = Record<string, ServerProxy>;

export async function runAlias(aliasPath: string, cliArgs: Record<string, string>): Promise<void> {
  // Register virtual module BEFORE importing the alias
  plugin({
    name: "mcp-cli-alias-sdk",
    setup(builder) {
      builder.module("mcp-cli", () => ({
        exports: {
          mcp: createMcpProxy(),
          args: cliArgs,
          file: (path: string) => Bun.file(path).text(),
          json: async (path: string) => JSON.parse(await Bun.file(path).text()),
        },
        loader: "object",
      }));
    },
  });

  // Defense-in-depth: verify the alias path is inside the aliases directory
  const resolved = resolve(aliasPath);
  if (!resolved.startsWith(`${ALIASES_DIR}/`)) {
    throw new Error(`Refusing to execute alias outside aliases directory: ${resolved}`);
  }

  // Execute the alias script
  await import(aliasPath);
}

function createMcpProxy(): McpProxy {
  return new Proxy({} as McpProxy, {
    get(_target, serverName: string) {
      return new Proxy({} as ServerProxy, {
        get(_inner, toolName: string) {
          return async (toolArgs?: Record<string, unknown>) => {
            const result = await ipcCall("callTool", {
              server: serverName,
              tool: toolName,
              arguments: toolArgs ?? {},
            });
            return extractContent(result);
          };
        },
      });
    },
  });
}

export function extractContent(result: unknown): unknown {
  // MCP results: { content: [{type: "text", text: "..."}] }
  // Unwrap to actual content for ergonomic alias authoring
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content) && content.length === 1 && content[0].type === "text" && content[0].text) {
      try {
        return JSON.parse(content[0].text);
      } catch {
        return content[0].text;
      }
    }
    // Multiple content items — return array of text
    return content.filter((c) => c.type === "text").map((c) => c.text);
  }
  return result;
}
