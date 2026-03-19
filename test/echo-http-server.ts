/**
 * Minimal HTTP (Streamable HTTP) MCP server for integration testing.
 *
 * Same tools as echo-server.ts (echo, add, fail) but served over HTTP
 * using StreamableHTTPServerTransport.
 *
 * Prints the listening port to stdout so the test harness can discover it.
 */
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mcpServer = new Server({ name: "echo-http-server", version: "0.1.0" }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
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

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
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

// Single stateful transport — handles one session at a time (sufficient for testing)
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
await mcpServer.connect(transport);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname !== "/mcp") {
    res.writeHead(404).end("Not found");
    return;
  }

  // Read body for POST requests
  let body: unknown;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
  }

  await transport.handleRequest(req, res, body);
});

httpServer.listen(0, "127.0.0.1", () => {
  const addr = httpServer.address();
  if (addr && typeof addr === "object") {
    console.log(addr.port);
  }
});
