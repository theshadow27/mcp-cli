/**
 * Minimal SSE MCP server for integration testing.
 *
 * Same tools as echo-server.ts (echo, add, fail) but served over SSE
 * using SSEServerTransport with Node.js http compat.
 *
 * Prints the listening port to stdout so the test harness can discover it.
 */
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function createMcpServer(): Server {
  const server = new Server({ name: "echo-sse-server", version: "0.1.0" }, { capabilities: { tools: {} } });

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

  return server;
}

// One transport per SSE connection
const transports = new Map<string, SSEServerTransport>();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/sse" && req.method === "GET") {
    // New SSE connection — create transport and MCP server
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    await mcpServer.connect(transport);
    return;
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    // Message for existing session
    const sessionId = url.searchParams.get("sessionId");
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      res.writeHead(400).end("No session");
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    await transport.handlePostMessage(req, res, body);
    return;
  }

  res.writeHead(404).end("Not found");
});

httpServer.listen(0, "127.0.0.1", () => {
  const addr = httpServer.address();
  if (addr && typeof addr === "object") {
    console.log(addr.port);
  }
});
