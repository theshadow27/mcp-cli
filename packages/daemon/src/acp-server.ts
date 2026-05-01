import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { ACP_SERVER_NAME, formatToolSignature } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AbstractWorkerServer, type WorkerServerDescriptor } from "./abstract-worker-server";
import { ACP_TOOLS } from "./acp-session/tools";
import type { StateDb } from "./db/state";
import type { MetricsCollector } from "./metrics";

export { isBaseWorkerEvent as isAcpWorkerEvent } from "./abstract-worker-server";

export class AcpServer extends AbstractWorkerServer {
  get descriptor(): WorkerServerDescriptor {
    return ACP_DESCRIPTOR;
  }

  constructor(
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: Logger,
    handshakeTimeoutMs = 10_000,
    metricsCollector?: MetricsCollector,
  ) {
    super(db, daemonId, clientFactory, logger, handshakeTimeoutMs, metricsCollector);
  }
}

const ACP_DESCRIPTOR: WorkerServerDescriptor = {
  providerName: "acp",
  displayName: "ACP",
  serverName: ACP_SERVER_NAME,
  workerScript: "acp-session-worker.ts",
  metrics: {
    crashLoopStopped: "mcpd_acp_worker_crash_loop_stopped",
    crashesTotal: "mcpd_acp_worker_crashes_total",
    activeSessions: "mcpd_acp_active_sessions",
    sessionsTotal: "mcpd_acp_sessions_total",
  },
};

export function buildAcpToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const def of ACP_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: ACP_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }
  return tools;
}
