/**
 * Virtual MCP server that exposes daemon metrics as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Read-only — no mutations.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MetricsCollector } from "./metrics";

export const METRICS_SERVER_NAME = "_metrics";

const TOOLS = [
  {
    name: "get_metrics",
    description: "Return a full JSON snapshot of all daemon metrics (counters, gauges, histograms).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_metric",
    description:
      "Return metric series matching a given name and optional label filter. Returns counters, gauges, or histogram entries whose name matches exactly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Exact metric name (e.g. mcpd_tool_calls_total)" },
        labels: {
          type: "object",
          description: "Optional label key-value pairs to filter by",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_health",
    description:
      "Return a summary health object: uptime, connected servers, active sessions, total tool calls, and error count.",
    inputSchema: { type: "object" as const, properties: {} },
  },
] as const;

export class MetricsServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;

  constructor(private metrics: MetricsCollector) {}

  async start(): Promise<{ client: Client; transport: Transport }> {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    this.server = new Server({ name: METRICS_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

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
        case "get_metrics":
          return { content: [{ type: "text" as const, text: JSON.stringify(this.metrics.toJSON(), null, 2) }] };

        case "get_metric":
          return this.handleGetMetric(args);

        case "get_health":
          return { content: [{ type: "text" as const, text: JSON.stringify(this.buildHealth(), null, 2) }] };

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    });

    await this.server.connect(serverTransport);
    this.client = new Client({ name: `mcp-cli/${METRICS_SERVER_NAME}`, version: "0.1.0" });
    await this.client.connect(clientTransport);

    return { client: this.client, transport: this.clientTransport };
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

  private handleGetMetric(args: Record<string, unknown> | undefined): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    const metricName = args?.name;
    if (typeof metricName !== "string" || !metricName) {
      return {
        content: [{ type: "text", text: 'Missing required parameter "name"' }],
        isError: true,
      };
    }

    const labelFilter = (args?.labels ?? {}) as Record<string, string>;
    const snap = this.metrics.toJSON();
    const matches: Array<Record<string, unknown>> = [];

    for (const c of snap.counters) {
      if (c.name === metricName && matchLabels(c.labels, labelFilter)) {
        matches.push({ type: "counter", ...c });
      }
    }
    for (const g of snap.gauges) {
      if (g.name === metricName && matchLabels(g.labels, labelFilter)) {
        matches.push({ type: "gauge", ...g });
      }
    }
    for (const h of snap.histograms) {
      if (h.name === metricName && matchLabels(h.labels, labelFilter)) {
        matches.push({ type: "histogram", ...h });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ name: metricName, series: matches }, null, 2) }],
    };
  }

  private buildHealth(): Record<string, unknown> {
    const snap = this.metrics.toJSON();
    const findGauge = (name: string) => snap.gauges.find((g) => g.name === name)?.value ?? 0;
    const findCounter = (name: string) =>
      snap.counters.filter((c) => c.name === name).reduce((sum, c) => sum + c.value, 0);

    return {
      uptime_seconds: findGauge("mcpd_uptime_seconds"),
      servers_total: findGauge("mcpd_servers_total"),
      servers_connected: findGauge("mcpd_servers_connected"),
      active_sessions: findGauge("mcpd_active_sessions"),
      tool_calls_total: findCounter("mcpd_tool_calls_total"),
      tool_errors_total: findCounter("mcpd_tool_errors_total"),
      ipc_requests_total: findCounter("mcpd_ipc_requests_total"),
      ipc_errors_total: findCounter("mcpd_ipc_errors_total"),
    };
  }
}

function matchLabels(actual: Record<string, string>, filter: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

/** Pre-build tool cache for pool registration. */
export function buildMetricsToolCache(): Map<string, ToolInfo> {
  const cache = new Map<string, ToolInfo>();
  for (const t of TOOLS) {
    cache.set(t.name, {
      server: METRICS_SERVER_NAME,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    });
  }
  return cache;
}
