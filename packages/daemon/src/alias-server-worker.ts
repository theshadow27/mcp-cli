/**
 * Bun Worker hosting an MCP Server for defineAlias aliases.
 *
 * Protocol:
 *   1. Parent sends initial config: { type: "init", aliases: AliasToolDef[] }
 *   2. Parent sends MCP JSON-RPC messages (forwarded by WorkerClientTransport)
 *   3. Worker sends MCP JSON-RPC responses back
 *   4. Parent can send: { type: "refresh", aliases: AliasToolDef[] } to hot-reload tools
 *
 * The MCP JSON-RPC messages and control messages share the postMessage channel.
 * Control messages have a `type` field; JSON-RPC messages have `jsonrpc`.
 */

import { readFile } from "node:fs/promises";
import type { AliasDefinition } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { registerMcpPlugin, stubProxy } from "./worker-plugin";
import { WorkerServerTransport } from "./worker-transport";

/** Serializable tool definition passed from the main thread */
export interface AliasToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  filePath: string;
}

/** Control messages from the main thread */
interface InitMessage {
  type: "init";
  aliases: AliasToolDef[];
}

interface RefreshMessage {
  type: "refresh";
  aliases: AliasToolDef[];
}

type ControlMessage = InitMessage | RefreshMessage;

function isControlMessage(data: unknown): data is ControlMessage {
  return typeof data === "object" && data !== null && "type" in data;
}

// -- Alias execution infrastructure --

let _captured: AliasDefinition | null = null;
// Getter defeats CFA narrowing — _captured is mutated by dynamic import() side effects
function getCaptured(): AliasDefinition | null {
  return _captured;
}

// Register virtual module for alias script imports
registerMcpPlugin({
  name: "mcp-cli-alias-server",
  onDefine: (def) => {
    _captured = def;
  },
  file: (path: string) => readFile(path, "utf-8"),
  json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
});

// -- Server setup --

declare const self: Worker;

let currentAliases: AliasToolDef[] = [];
let transport: WorkerServerTransport | null = null;
let server: Server | null = null;

async function startServer(aliases: AliasToolDef[]): Promise<void> {
  currentAliases = aliases;

  server = new Server({ name: "_aliases", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: currentAliases.map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: a.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const aliasDef = currentAliases.find((a) => a.name === name);
    if (!aliasDef) {
      return {
        content: [{ type: "text" as const, text: `Alias "${name}" not found` }],
        isError: true,
      };
    }

    try {
      const result = await executeAlias(aliasDef, args ?? {});
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  transport = new WorkerServerTransport(self);
  await server.connect(transport);

  // After transport.start() (called by server.connect), wrap self.onmessage
  // to intercept control messages before they reach the transport.
  const transportHandler = self.onmessage;
  self.onmessage = async (event: MessageEvent) => {
    const data = event.data;
    if (isControlMessage(data)) {
      if (data.type === "refresh") {
        currentAliases = data.aliases;
        await server?.notification({ method: "notifications/tools/list_changed" });
        return;
      }
    }
    // Forward JSON-RPC messages to the transport
    transportHandler?.call(self, event);
  };
}

/** Import and execute a defineAlias script */
async function executeAlias(aliasDef: AliasToolDef, args: Record<string, unknown>): Promise<unknown> {
  _captured = null;

  // Cache-bust to allow re-importing after alias updates
  const importPath = `${aliasDef.filePath}?t=${Date.now()}`;
  await import(importPath);

  const def = getCaptured();
  if (!def) {
    throw new Error(`Script at ${aliasDef.filePath} did not call defineAlias()`);
  }

  // Validate input if schema is present
  let parsedInput = args;
  if (def.input) {
    const result = def.input.safeParse(args);
    if (!result.success) {
      throw new Error(`Invalid input: ${result.error.message}`);
    }
    parsedInput = result.data as Record<string, unknown>;
  }

  const ctx = {
    mcp: stubProxy,
    args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
    file: (path: string) => readFile(path, "utf-8"),
    json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
  };

  const output = await def.fn(parsedInput, ctx);

  // Validate output if schema is present
  if (def.output) {
    const result = def.output.safeParse(output);
    if (!result.success) {
      throw new Error(`Invalid output: ${result.error.message}`);
    }
    return result.data;
  }

  return output;
}

// -- Initial message handler (before MCP server is started) --
// Only handles the "init" control message to bootstrap the server.
// After startServer(), self.onmessage is replaced with a handler that
// routes control messages vs JSON-RPC messages.

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (isControlMessage(data) && data.type === "init") {
    await startServer(data.aliases);
  }
};
