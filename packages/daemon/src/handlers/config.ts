import { IPC_ERROR } from "@mcp-cli/core";
import type { IpcMethod, ResolvedConfig } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import type { ServerPool } from "../server-pool";

export class ConfigHandlers {
  constructor(
    private pool: ServerPool,
    private config: ResolvedConfig,
    private onReloadConfig: (() => Promise<void>) | null,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("getConfig", async () => {
      const servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }> = {};
      const statusMap = new Map(this.pool.listServers().map((s) => [s.name, s]));
      for (const [name, resolved] of this.config.servers) {
        const status = statusMap.get(name);
        servers[name] = {
          transport: status?.transport ?? "unknown",
          source: resolved.source.file,
          scope: resolved.source.scope,
          toolCount: status?.toolCount ?? 0,
        };
      }
      return {
        servers,
        sources: this.config.sources,
      };
    });

    handlers.set("reloadConfig", async () => {
      if (!this.onReloadConfig) {
        throw Object.assign(new Error("Config reload not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }
      await this.onReloadConfig();
      return { ok: true };
    });
  }
}
