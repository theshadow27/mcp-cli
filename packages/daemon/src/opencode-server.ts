import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { OPENCODE_SERVER_NAME, formatToolSignature } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AbstractWorkerServer, type WorkerServerDescriptor } from "./abstract-worker-server";
import type { StateDb } from "./db/state";
import type { MetricsCollector } from "./metrics";
import { OPENCODE_TOOLS } from "./opencode-session/tools";

export { isBaseWorkerEvent as isOpenCodeWorkerEvent } from "./abstract-worker-server";

export class OpenCodeServer extends AbstractWorkerServer {
  get descriptor(): WorkerServerDescriptor {
    return OPENCODE_DESCRIPTOR;
  }

  constructor(
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: Logger,
    handshakeTimeoutMs = 10_000,
    workerFactory?: (scriptPath: string) => Worker,
    metricsCollector?: MetricsCollector,
  ) {
    super(db, daemonId, clientFactory, logger, handshakeTimeoutMs, metricsCollector, workerFactory);
  }
}

const OPENCODE_DESCRIPTOR: WorkerServerDescriptor = {
  providerName: "opencode",
  displayName: "OpenCode",
  serverName: OPENCODE_SERVER_NAME,
  workerScript: "opencode-session-worker.ts",
  metrics: {
    crashLoopStopped: "mcpd_opencode_worker_crash_loop_stopped",
    crashesTotal: "mcpd_opencode_worker_crashes_total",
    activeSessions: "mcpd_opencode_active_sessions",
    sessionsTotal: "mcpd_opencode_sessions_total",
  },
};

export function buildOpenCodeToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const def of OPENCODE_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: OPENCODE_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }
  return tools;
}
