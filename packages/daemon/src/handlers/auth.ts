import {
  AuthStatusParamsSchema,
  IPC_ERROR,
  ToolResultError,
  TriggerAuthParamsSchema,
  unwrapToolResult,
} from "@mcp-cli/core";
import type { IpcMethod, ServerAuthStatus } from "@mcp-cli/core";
import { McpOAuthProvider } from "../auth/oauth-provider";
import { runOAuthFlowWithDcrRetry } from "../auth/oauth-retry";
import type { RequestHandler } from "../handler-types";
import type { ServerPool } from "../server-pool";

export class AuthHandlers {
  constructor(private pool: ServerPool) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("triggerAuth", async (params, _ctx) => {
      const { server, force } = TriggerAuthParamsSchema.parse(params);
      const serverUrl = this.pool.getServerUrl(server);

      // Non-remote server — check for `auth` tool convention
      if (!serverUrl) {
        let tools: Awaited<ReturnType<ServerPool["listTools"]>>;
        try {
          tools = await this.pool.listTools(server);
        } catch {
          tools = [];
        }
        const hasAuthTool = tools.some((t) => t.name === "auth");
        if (!hasAuthTool) {
          throw Object.assign(
            new Error(`Server "${server}" not found or does not support auth (no OAuth endpoint and no "auth" tool)`),
            { code: IPC_ERROR.SERVER_NOT_FOUND },
          );
        }

        const result = await this.pool.callTool(server, "auth", {});
        let text: string;
        try {
          text = unwrapToolResult(result);
        } catch (e) {
          const msg = e instanceof ToolResultError ? e.message : "auth tool returned an error";
          throw Object.assign(new Error(msg), { code: IPC_ERROR.INTERNAL_ERROR });
        }
        return { ok: true, message: text || "Authenticated via auth tool" };
      }

      const poolDb = this.pool.getDb();
      if (!poolDb) {
        throw Object.assign(new Error("Database not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }

      // Read OAuth config from server configuration
      const serverConfig = this.pool.getServerConfig(server);
      const { clientId, clientSecret, callbackPort, scope } = serverConfig ?? {};

      // --force: drop stored tokens up front so a stale/revoked credential is
      // not reused, forcing a clean interactive flow without waiting for the
      // token endpoint to reject it.
      if (force) {
        new McpOAuthProvider(server, serverUrl, poolDb).invalidateCredentials("tokens");
      }

      let flowResult: Awaited<ReturnType<typeof runOAuthFlowWithDcrRetry>>;
      try {
        flowResult = await runOAuthFlowWithDcrRetry(server, serverUrl, poolDb, {
          clientId,
          clientSecret,
          callbackPort,
          scope,
        });
      } catch (err) {
        // Name the server + credential store + recovery path. The bare SDK
        // message ("The refresh_token provided was invalid.") gave no context.
        const store = poolDb.getTokens(server) ? "mcx (SQLite)" : "the macOS Keychain (Claude Code)";
        const detail = err instanceof Error ? err.message : String(err);
        throw Object.assign(
          new Error(
            `Authentication for "${server}" failed: ${detail}\n` +
              `The stored credential (from ${store}) could not be used and automatic browser re-auth did not complete.\n` +
              `Retry with: mcx auth ${server} --force  (drops the stored credential and forces a fresh browser flow).`,
          ),
          { code: IPC_ERROR.INTERNAL_ERROR },
        );
      }

      await this.pool.restart(server);

      if (flowResult === "already_authorized") {
        return { ok: true, message: "Already authorized" };
      }
      return { ok: true, message: "Authenticated successfully" };
    });

    handlers.set("authStatus", async (params, _ctx) => {
      const { server } = AuthStatusParamsSchema.parse(params ?? {});
      const allServers = this.pool.listServers();
      const filtered = server ? allServers.filter((s) => s.name === server) : allServers;

      if (server && filtered.length === 0) {
        throw Object.assign(new Error(`Server "${server}" not found`), { code: IPC_ERROR.SERVER_NOT_FOUND });
      }

      const poolDb = this.pool.getDb();
      const results: ServerAuthStatus[] = [];

      for (const srv of filtered) {
        const serverUrl = this.pool.getServerUrl(srv.name);
        let authSupport: ServerAuthStatus["authSupport"] = "none";
        let status: ServerAuthStatus["status"] = "unknown";
        let expiresAt: number | undefined;

        if (serverUrl) {
          // Remote server — check for OAuth tokens via provider (includes keychain fallback)
          authSupport = "oauth";
          if (poolDb) {
            const serverConfig = this.pool.getServerConfig(srv.name);
            const provider = new McpOAuthProvider(srv.name, serverUrl, poolDb, {
              clientId: serverConfig?.clientId,
              clientSecret: serverConfig?.clientSecret,
              scope: serverConfig?.scope,
            });
            const tokens = await provider.tokens();
            if (tokens) {
              // Check raw expires_at from DB for accurate expiry detection
              const rawExpiry = poolDb.getTokenExpiry(srv.name);
              if (rawExpiry !== null && rawExpiry <= Date.now()) {
                status = "expired";
                expiresAt = rawExpiry;
              } else {
                status = "authenticated";
                if (rawExpiry !== null) {
                  expiresAt = rawExpiry;
                } else if (tokens.expires_in !== undefined && tokens.expires_in > 0) {
                  // Keychain token with expiry info
                  expiresAt = Date.now() + tokens.expires_in * 1000;
                }
              }
            } else {
              status = "not_authenticated";
            }
          }
        } else if (srv.transport !== "virtual") {
          // Stdio server — only check cached tools, never spawn the process
          const cachedTools = this.pool.getCachedTools(srv.name);
          if (cachedTools?.some((t) => t.name === "auth")) {
            authSupport = "auth_tool";
            status = "unknown"; // can't check without calling it
          }
        }

        results.push({
          server: srv.name,
          transport: srv.transport,
          authSupport,
          status,
          ...(expiresAt !== undefined && { expiresAt }),
        });
      }

      return { servers: results };
    });
  }
}
