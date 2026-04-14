/**
 * Shared MCP proxy factory.
 *
 * Builds the `mcp.server.tool(args)` proxy used by both the standalone alias
 * runner and `mcx phase run`. Both call sites previously carried a private
 * copy of this Proxy wiring; centralising it here ensures a single source of
 * truth for the IPC shape (`callTool` params) and response extraction.
 */

import { type McpProxy, extractContent } from "./alias";
import { ipcCall } from "./ipc-client";

export interface CreateMcpProxyOptions {
  /**
   * Working directory forwarded as `cwd` to the daemon so server config
   * resolution (`.mcp.json`, env expansion) picks the right repo. Can be a
   * literal string or a thunk when the caller wants to defer to `process.cwd()`
   * at call time.
   */
  cwd: string | (() => string);
  /**
   * IPC caller. Defaults to the real `ipcCall`; tests inject a stub to avoid
   * needing a running daemon.
   */
  call?: typeof ipcCall;
}

export function createMcpProxy(opts: CreateMcpProxyOptions): McpProxy {
  const call = opts.call ?? ipcCall;
  const resolveCwd = typeof opts.cwd === "function" ? opts.cwd : () => opts.cwd as string;
  return new Proxy({} as McpProxy, {
    get(_target, serverName: string) {
      return new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>, {
        get(_inner, toolName: string) {
          return async (toolArgs?: Record<string, unknown>) => {
            const result = await call("callTool", {
              server: serverName,
              tool: toolName,
              arguments: toolArgs ?? {},
              cwd: resolveCwd(),
            });
            return extractContent(result);
          };
        },
      });
    },
  });
}
