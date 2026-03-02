/**
 * Unix socket IPC server.
 *
 * Listens on ~/.mcp-cli/mcpd.sock for NDJSON requests from the `mcp` CLI.
 */

import { unlinkSync } from "node:fs";
import type {
  CallToolParams,
  GetToolInfoParams,
  GrepToolsParams,
  IpcError,
  IpcMethod,
  IpcRequest,
  IpcResponse,
  ListToolsParams,
  ResolvedConfig,
  RestartServerParams,
  TriggerAuthParams,
} from "@mcp-cli/core";
import { DB_PATH, IPC_ERROR, SOCKET_PATH, encodeResponse } from "@mcp-cli/core";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { startCallbackServer } from "./auth/callback-server.js";
import { McpOAuthProvider } from "./auth/oauth-provider.js";
import type { StateDb } from "./db/state.js";
import type { ServerPool } from "./server-pool.js";

type RequestHandler = (params: unknown) => Promise<unknown>;

export class IpcServer {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private handlers = new Map<IpcMethod, RequestHandler>();
  private onActivity: () => void;

  constructor(
    private pool: ServerPool,
    private config: ResolvedConfig,
    private db: StateDb,
    options: { onActivity: () => void },
  ) {
    this.onActivity = options.onActivity;
    this.registerHandlers();
  }

  /** Start listening on the Unix socket */
  start(): void {
    // Remove stale socket file
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // doesn't exist, fine
    }

    this.server = Bun.listen({
      unix: SOCKET_PATH,
      socket: {
        data: (socket, data) => {
          this.handleData(socket, data);
        },
        error: (_socket, err) => {
          console.error("[ipc] Socket error:", err.message);
        },
        close: () => {
          // client disconnected
        },
        open: () => {
          this.onActivity();
        },
      },
    });

    console.error(`[ipc] Listening on ${SOCKET_PATH}`);
  }

  /** Stop listening and clean up socket */
  stop(): void {
    this.server?.stop(true);
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // already gone
    }
  }

  // -- Data handling --

  private buffers = new WeakMap<object, string>();

  private handleData(socket: { write(data: string): number }, data: Buffer): void {
    const prev = this.buffers.get(socket) ?? "";
    const text = prev + data.toString();
    const lines = text.split("\n");

    // Last element is either empty (complete line) or partial (buffer it)
    const remaining = lines.pop() ?? "";
    this.buffers.set(socket, remaining);

    for (const line of lines) {
      if (line.trim() === "") continue;
      this.handleLine(socket, line);
    }
  }

  private handleLine(socket: { write(data: string): number }, line: string): void {
    this.onActivity();

    let request: IpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      const response: IpcResponse = {
        id: "unknown",
        error: { code: IPC_ERROR.PARSE_ERROR, message: "Invalid JSON" },
      };
      socket.write(encodeResponse(response));
      return;
    }

    this.dispatch(request).then(
      (result) => {
        const response: IpcResponse = { id: request.id, result };
        socket.write(encodeResponse(response));
      },
      (err) => {
        const response: IpcResponse = {
          id: request.id,
          error: toIpcError(err),
        };
        socket.write(encodeResponse(response));
      },
    );
  }

  private async dispatch(request: IpcRequest): Promise<unknown> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      throw Object.assign(new Error(`Unknown method: ${request.method}`), {
        code: IPC_ERROR.METHOD_NOT_FOUND,
      });
    }
    return handler(request.params);
  }

  // -- Handler registration --

  private registerHandlers(): void {
    this.handlers.set("ping", async () => ({ pong: true, time: Date.now() }));

    this.handlers.set("status", async () => ({
      pid: process.pid,
      uptime: process.uptime(),
      servers: this.pool.listServers(),
      dbPath: DB_PATH,
    }));

    this.handlers.set("listServers", async () => this.pool.listServers());

    this.handlers.set("listTools", async (params) => {
      const { server, format } = (params ?? {}) as ListToolsParams;
      return this.pool.listTools(server);
    });

    this.handlers.set("getToolInfo", async (params) => {
      const { server, tool } = params as GetToolInfoParams;
      return this.pool.getToolInfo(server, tool);
    });

    this.handlers.set("grepTools", async (params) => {
      const { pattern } = params as GrepToolsParams;
      return this.pool.grepTools(pattern);
    });

    this.handlers.set("callTool", async (params) => {
      const { server, tool, arguments: args } = params as CallToolParams;
      const start = Date.now();
      try {
        const result = await this.pool.callTool(server, tool, args);
        this.db.recordUsage(server, tool, Date.now() - start, true);
        return result;
      } catch (err) {
        this.db.recordUsage(server, tool, Date.now() - start, false, err instanceof Error ? err.message : String(err));
        throw err;
      }
    });

    this.handlers.set("triggerAuth", async (params) => {
      const { server } = params as TriggerAuthParams;
      const serverUrl = this.pool.getServerUrl(server);
      if (!serverUrl) {
        throw Object.assign(new Error(`Server "${server}" not found or is not a remote (SSE/HTTP) server`), {
          code: IPC_ERROR.SERVER_NOT_FOUND,
        });
      }

      const poolDb = this.pool.getDb();
      if (!poolDb) {
        throw Object.assign(new Error("Database not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }

      // Start callback server for OAuth redirect
      const callback = startCallbackServer();
      try {
        // Create provider with callback URL
        const provider = new McpOAuthProvider(server, serverUrl, poolDb);
        provider.setRedirectUrl(callback.url);

        // Run the SDK auth orchestrator
        const result = await auth(provider, { serverUrl });

        if (result === "AUTHORIZED") {
          // Already authorized (tokens were valid) — restart server to reconnect
          await this.pool.restart(server);
          callback.stop();
          return { ok: true, message: "Already authorized" };
        }

        // result === "REDIRECT" — browser was opened, wait for callback
        const code = await callback.waitForCode;

        // Exchange code for tokens
        await auth(provider, { serverUrl, authorizationCode: code });

        // Reconnect with new tokens
        await this.pool.restart(server);

        return { ok: true, message: "Authenticated successfully" };
      } catch (err) {
        callback.stop();
        throw err;
      }
    });

    this.handlers.set("restartServer", async (params) => {
      const { server } = (params ?? {}) as RestartServerParams;
      await this.pool.restart(server);
      return { ok: true };
    });

    this.handlers.set("getConfig", async () => {
      const servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }> = {};
      for (const [name, resolved] of this.config.servers) {
        const status = this.pool.listServers().find((s) => s.name === name);
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

    this.handlers.set("shutdown", async () => {
      // Schedule shutdown after response is sent
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    });
  }
}

// -- Helpers --

function toIpcError(err: unknown): IpcError {
  if (err instanceof Error) {
    const code = (err as unknown as { code?: number }).code;
    return {
      code: typeof code === "number" ? code : IPC_ERROR.INTERNAL_ERROR,
      message: err.message,
    };
  }
  return { code: IPC_ERROR.INTERNAL_ERROR, message: String(err) };
}
