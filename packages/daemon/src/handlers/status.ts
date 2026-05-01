import { BUILD_VERSION, PROTOCOL_VERSION } from "@mcp-cli/core";
import type { IpcMethod, ServeInstanceInfo } from "@mcp-cli/core";
import { options } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";
import { getPortHolder } from "../port-holder";
import type { ServerPool } from "../server-pool";
import type { ServeHandlers } from "./serve";

export class StatusHandler {
  constructor(
    private readonly pool: ServerPool,
    private readonly db: StateDb,
    private readonly serveHandlers: ServeHandlers,
    private readonly serveInstances: Map<string, ServeInstanceInfo>,
    private readonly getWsPortInfo: (() => { actual: number | null; expected: number }) | null,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("status", async (_params, _ctx) => {
      const servers = this.pool.listServers();
      const usageStats = this.db.getUsageStats();

      for (const server of servers) {
        const serverStats = usageStats.filter((s) => s.serverName === server.name);
        if (serverStats.length > 0) {
          server.callCount = serverStats.reduce((sum, s) => sum + s.callCount, 0);
          server.errorCount = serverStats.reduce((sum, s) => sum + s.errorCount, 0);
          const totalDuration = serverStats.reduce((sum, s) => sum + s.totalDurationMs, 0);
          server.avgDurationMs = Math.round(totalDuration / server.callCount);
        }
      }

      const wsPortInfo = this.getWsPortInfo?.();
      const hasMismatch = wsPortInfo != null && wsPortInfo.actual != null && wsPortInfo.actual !== wsPortInfo.expected;
      const wsPortHolder = hasMismatch ? await getPortHolder(wsPortInfo.expected) : null;
      this.serveHandlers.pruneStaleInstances();
      return {
        pid: process.pid,
        uptime: process.uptime(),
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: BUILD_VERSION,
        servers,
        dbPath: options.DB_PATH,
        usageStats,
        wsPort: wsPortInfo?.actual ?? null,
        wsPortExpected: wsPortInfo?.expected,
        wsPortHolder,
        serveInstances: [...this.serveInstances.values()],
      };
    });
  }
}
