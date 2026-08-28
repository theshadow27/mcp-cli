/**
 * Virtual MCP server that exposes daemon metrics as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Read-only — no mutations.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { BUILD_COMMIT, BUILD_VERSION, METRICS_SERVER_NAME, PROTOCOL_VERSION } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McxDb } from "./db/state";
import type { MetricsCollector } from "./metrics";
import { type DomainSpendResult, queryDomainSpend } from "./metrics-domain-spend";
import type { QuotaPoller } from "./quota";

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
  {
    name: "quota_status",
    description:
      "Return current Claude usage quota status: 5-hour and 7-day utilization percentages, " +
      "reset timestamps, and extra usage budget. Utilization is 0-100 (percentage). " +
      "Returns null fields if no OAuth token is available or the endpoint cannot be reached.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "build_info",
    description:
      "Return the running daemon's build provenance: version, IPC protocol hash, and the source " +
      "commit the binary was compiled from — `<sha12>`, `<sha12>-dirty` (uncommitted tree at " +
      "build time), `<sha12>-unknown` (dirty check failed), or null for a daemon running from " +
      "source. Answers 'does this running daemon actually contain commit X' " +
      "(git merge-base --is-ancestor <commit> HEAD) without grepping the compiled binary.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_domain_spend",
    description:
      "Return per-domain spend rolled up from agent_sessions: totals (cost, tokens, session " +
      "count) per domain plus the per-session, per-model rows they're built from. Every row " +
      "and total is labeled with its source — only 'daemon' exists today (sessions the " +
      "daemon itself spawned); a future transcript-scraped source will never be silently " +
      "merged into these totals. Sessions whose domain_id names no registered domain are " +
      "grouped under 'unassigned'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string", description: "Restrict to one domain by name. Omit for all domains." },
        sinceMs: { type: "number", description: "Only sessions spawned at or after this epoch-ms cutoff." },
      },
    },
  },
] as const;

export class MetricsServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;

  private quotaPoller: QuotaPoller | null;
  private db: McxDb | null;

  constructor(
    private metrics: MetricsCollector,
    quotaPoller?: QuotaPoller | null,
    db?: McxDb | null,
  ) {
    this.quotaPoller = quotaPoller ?? null;
    this.db = db ?? null;
  }

  async start(): Promise<{ client: Client; transport: Transport; tools: Map<string, ToolInfo> }> {
    if (this.server) {
      throw new Error("MetricsServer already started");
    }

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

        case "quota_status":
          return { content: [{ type: "text" as const, text: JSON.stringify(this.buildQuotaStatus(), null, 2) }] };

        case "build_info":
          return { content: [{ type: "text" as const, text: JSON.stringify(buildInfo(), null, 2) }] };

        case "get_domain_spend":
          return this.handleGetDomainSpend(args);

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

    return { client: this.client, transport: this.clientTransport, tools: buildMetricsToolCache() };
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

    const rawLabels = args?.labels ?? {};
    if (typeof rawLabels !== "object" || rawLabels === null || Array.isArray(rawLabels)) {
      return {
        content: [{ type: "text", text: '"labels" must be an object with string values' }],
        isError: true,
      };
    }
    for (const [k, v] of Object.entries(rawLabels)) {
      if (typeof v !== "string") {
        return {
          content: [{ type: "text", text: `Label "${k}" must be a string, got ${typeof v}` }],
          isError: true,
        };
      }
    }
    const labelFilter = rawLabels as Record<string, string>;
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

  private handleGetDomainSpend(args: Record<string, unknown> | undefined): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "get_domain_spend requires a McxDb; none was configured on this daemon" }],
        isError: true,
      };
    }

    const rawDomain = args?.domain;
    if (rawDomain !== undefined && typeof rawDomain !== "string") {
      return { content: [{ type: "text", text: '"domain" must be a string' }], isError: true };
    }

    const rawSinceMs = args?.sinceMs;
    if (rawSinceMs !== undefined && typeof rawSinceMs !== "number") {
      return { content: [{ type: "text", text: '"sinceMs" must be a number' }], isError: true };
    }

    const result: DomainSpendResult = queryDomainSpend(this.db, {
      domain: rawDomain,
      sinceMs: rawSinceMs,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  private buildQuotaStatus(): Record<string, unknown> {
    const status = this.quotaPoller?.status;
    if (!status) {
      const lastAttemptAt = this.quotaPoller?.lastAttemptAt ?? null;
      // "Quota monitoring not started" is only accurate before the poller's first tick.
      // Once it has attempted at least once and still has no status, that's a real,
      // timestamped condition (no OAuth token found on this host) — not a startup race
      // that will resolve itself, so say so instead of implying "give it time" forever.
      const defaultError =
        lastAttemptAt === null
          ? "Quota monitoring not started"
          : `No Claude Code OAuth token found as of last attempt (${new Date(lastAttemptAt).toISOString()})`;
      return {
        available: false,
        lastError: this.quotaPoller?.lastError ?? defaultError,
        lastAttemptAt,
      };
    }
    return {
      available: true,
      fiveHour: status.fiveHour,
      sevenDay: status.sevenDay,
      sevenDaySonnet: status.sevenDaySonnet,
      sevenDayOpus: status.sevenDayOpus,
      extraUsage: status.extraUsage,
      fetchedAt: status.fetchedAt,
      lastError: this.quotaPoller?.lastError ?? null,
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

/**
 * Build provenance of the running daemon (#3264).
 *
 * Read from the daemon's own compiled-in constants rather than plumbed over
 * IPC: this server runs in-process, so what it reports is by construction the
 * binary that is actually serving — which is the whole question. A `+epoch`
 * build stamp can't distinguish a fresh build of a stale checkout from one
 * containing a merged fix; the commit can.
 */
export function buildInfo(): Record<string, unknown> {
  return {
    version: BUILD_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    commit: BUILD_COMMIT,
  };
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
