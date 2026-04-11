/**
 * Virtual MCP server that exposes trace data as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Read-only — queries spans table via StateDb API.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { TRACING_SERVER_NAME } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StateDb } from "./db/state";

/** Maximum serialized response size in bytes (5 MB). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const TOOLS = [
  {
    name: "query_traces",
    description:
      "Query trace spans with optional filters. Returns matching spans ordered by start time (newest first). " +
      "Use to search by daemon, trace, server, tool, status, or time range. Supports cursor-based pagination via after_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        daemon_id: { type: "string", description: "Filter by daemon instance ID" },
        trace_id: { type: "string", description: "Filter by trace ID" },
        server: { type: "string", description: "Filter spans whose name contains this server name" },
        tool: {
          type: "string",
          description: "Filter spans whose name ends with :toolName (structured span name convention)",
        },
        status: {
          type: "string",
          enum: ["OK", "ERROR", "UNSET"],
          description: "Filter by span status",
        },
        since_ms: {
          type: "number",
          description: "Only return spans with start_time_ms >= this value (epoch milliseconds)",
        },
        until_ms: {
          type: "number",
          description: "Only return spans with start_time_ms <= this value (epoch milliseconds)",
        },
        limit: {
          type: "number",
          description: "Maximum number of spans to return (default: 100, max: 1000)",
        },
        after_id: {
          type: "number",
          description:
            "Cursor for pagination: only return spans with id < this value (use last span's id from previous page)",
        },
      },
    },
  },
  {
    name: "list_daemons",
    description:
      "List distinct daemon instances that have recorded spans. Returns daemon_id, earliest and latest span times, and span count.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_trace",
    description:
      "Get all spans for a specific trace ID, ordered by start time. Shows the full call tree for a single trace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        trace_id: { type: "string", description: "The trace ID to look up" },
      },
      required: ["trace_id"],
    },
  },
] as const;

export class TracingServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;

  constructor(private db: StateDb) {}

  async start(): Promise<{ client: Client; transport: Transport; tools: Map<string, ToolInfo> }> {
    if (this.server) {
      throw new Error("TracingServer already started");
    }

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    this.server = new Server({ name: TRACING_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "query_traces":
          return this.handleQueryTraces(args);

        case "list_daemons":
          return this.handleListDaemons();

        case "get_trace":
          return this.handleGetTrace(args);

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    });

    await this.server.connect(serverTransport);
    this.client = new Client({ name: `mcp-cli/${TRACING_SERVER_NAME}`, version: "0.1.0" });
    await this.client.connect(clientTransport);

    return { client: this.client, transport: this.clientTransport, tools: buildTracingToolCache() };
  }

  async stop(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.server?.close();
    } catch {
      // ignore close errors
    }
    this.server = null;
    this.client = null;
    this.serverTransport = null;
    this.clientTransport = null;
  }

  private handleQueryTraces(args: Record<string, unknown> | undefined): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    const spans = this.db.querySpans({
      daemonId: typeof args?.daemon_id === "string" && args.daemon_id ? args.daemon_id : undefined,
      traceId: typeof args?.trace_id === "string" && args.trace_id ? args.trace_id : undefined,
      server: typeof args?.server === "string" && args.server ? args.server : undefined,
      tool: typeof args?.tool === "string" && args.tool ? args.tool : undefined,
      status: typeof args?.status === "string" && args.status ? args.status : undefined,
      sinceMs: typeof args?.since_ms === "number" ? args.since_ms : undefined,
      untilMs: typeof args?.until_ms === "number" ? args.until_ms : undefined,
      limit: typeof args?.limit === "number" ? args.limit : undefined,
      afterId: typeof args?.after_id === "number" ? args.after_id : undefined,
    });

    return sizeGuardedResponse({ spans });
  }

  private handleListDaemons(): {
    content: Array<{ type: "text"; text: string }>;
  } {
    const daemons = this.db.listDaemons();
    return { content: [{ type: "text", text: JSON.stringify({ daemons }, null, 2) }] };
  }

  private handleGetTrace(args: Record<string, unknown> | undefined): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    const traceId = args?.trace_id;
    if (typeof traceId !== "string" || !traceId) {
      return {
        content: [{ type: "text", text: 'Missing required parameter "trace_id"' }],
        isError: true,
      };
    }

    const spans = this.db.getTraceSpans(traceId);
    return sizeGuardedResponse({ trace_id: traceId, spans });
  }
}

/** Serialize response JSON with a size guard. If over MAX_RESPONSE_BYTES, truncate spans. */
function sizeGuardedResponse(data: { spans: unknown[]; [key: string]: unknown }): {
  content: Array<{ type: "text"; text: string }>;
} {
  const json = JSON.stringify(data, null, 2);
  if (json.length <= MAX_RESPONSE_BYTES) {
    return { content: [{ type: "text", text: json }] };
  }

  // Binary search for safe span count
  let lo = 0;
  let hi = data.spans.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const trial = JSON.stringify({ ...data, spans: data.spans.slice(0, mid), truncated: true }, null, 2);
    if (trial.length <= MAX_RESPONSE_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const truncated = { ...data, spans: data.spans.slice(0, lo), truncated: true };
  return { content: [{ type: "text", text: JSON.stringify(truncated, null, 2) }] };
}

/** Pre-build tool cache for pool registration. */
export function buildTracingToolCache(): Map<string, ToolInfo> {
  const cache = new Map<string, ToolInfo>();
  for (const t of TOOLS) {
    cache.set(t.name, {
      server: TRACING_SERVER_NAME,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    });
  }
  return cache;
}
