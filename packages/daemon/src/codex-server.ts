import type { JsonSchema, Logger, ToolInfo } from "@mcp-cli/core";
import { CODEX_SERVER_NAME, formatToolSignature } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AbstractWorkerServer, type WorkerServerDescriptor } from "./abstract-worker-server";
import { CODEX_TOOLS } from "./codex-session/tools";
import type { StateDb } from "./db/state";
import type { MetricsCollector } from "./metrics";

export { isBaseWorkerEvent as isWorkerEvent } from "./abstract-worker-server";

export class CodexServer extends AbstractWorkerServer {
  get descriptor(): WorkerServerDescriptor {
    return CODEX_DESCRIPTOR;
  }

  constructor(
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: Logger,
    handshakeTimeoutMs = 10_000,
    metricsCollector?: MetricsCollector,
    workerFactory?: (scriptPath: string) => Worker,
  ) {
    super(db, daemonId, clientFactory, logger, handshakeTimeoutMs, metricsCollector, workerFactory);
  }
}

const CODEX_DESCRIPTOR: WorkerServerDescriptor = {
  providerName: "codex",
  displayName: "Codex",
  serverName: CODEX_SERVER_NAME,
  workerScript: "codex-session-worker.ts",
  metrics: {
    crashLoopStopped: "mcpd_codex_worker_crash_loop_stopped",
    crashesTotal: "mcpd_codex_worker_crashes_total",
    activeSessions: "mcpd_codex_active_sessions",
    sessionsTotal: "mcpd_codex_sessions_total",
  },
};

export function buildCodexToolCache(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const def of CODEX_TOOLS) {
    const inputSchema = def.inputSchema as JsonSchema;
    tools.set(def.name, {
      name: def.name,
      server: CODEX_SERVER_NAME,
      description: def.description,
      inputSchema,
      signature: formatToolSignature(def.name, inputSchema),
    });
  }
  return tools;
}
