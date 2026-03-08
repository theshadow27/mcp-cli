/**
 * Slow stdio MCP server for stress/timeout testing.
 *
 * Adds an artificial delay (configurable via SLOW_MS env, default 2000ms)
 * before responding to tool calls. Useful for testing that:
 *   - slow servers don't wedge the daemon for other servers
 *   - timeout budgets are respected end-to-end
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SLOW_MS = Number(process.env.SLOW_MS) || 2_000;

const server = new Server({ name: "slow-echo-server", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "slow_echo",
      description: `Echoes after ${SLOW_MS}ms delay`,
      inputSchema: {
        type: "object" as const,
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { arguments: args } = req.params;
  await Bun.sleep(SLOW_MS);
  return {
    content: [{ type: "text", text: String((args as Record<string, unknown>)?.message ?? "") }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
