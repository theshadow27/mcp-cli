/**
 * Minimal stdio MCP server for integration testing.
 *
 * Tools:
 *   echo  — returns { text: input.message }
 *   add   — returns { result: a + b }
 *   fail  — always throws (error-handling test)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-server", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Returns the input message",
      inputSchema: {
        type: "object" as const,
        properties: { message: { type: "string", description: "Message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Adds two numbers",
      inputSchema: {
        type: "object" as const,
        properties: {
          a: { type: "number", description: "First operand" },
          b: { type: "number", description: "Second operand" },
        },
        required: ["a", "b"],
      },
    },
    {
      name: "fail",
      description: "Always fails (for error-handling tests)",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "echo":
      return {
        content: [{ type: "text", text: String((args as Record<string, unknown>)?.message ?? "") }],
      };

    case "add": {
      const a = Number((args as Record<string, unknown>)?.a);
      const b = Number((args as Record<string, unknown>)?.b);
      return { content: [{ type: "text", text: String(a + b) }] };
    }

    case "fail":
      return {
        isError: true,
        content: [{ type: "text", text: "intentional failure" }],
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
