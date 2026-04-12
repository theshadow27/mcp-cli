/**
 * Dry-run context for phases (#1296).
 *
 * Wraps an AliasContext so that side-effectful accessors (`mcp.*`, `state.set`,
 * `state.delete`, `globalState.set`, `globalState.delete`) are logged instead
 * of dispatched. Non-mutating reads (`state.get`, `state.all`) return
 * `undefined` / `{}` so handlers still progress through their control flow
 * without touching the daemon, DB, or network.
 */

import type { AliasContext, AliasStateAccessor, McpProxy } from "./alias";

export type DryRunLogger = (line: string) => void;

function formatArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export function createDryRunMcp(log: DryRunLogger): McpProxy {
  return new Proxy({} as McpProxy, {
    get(_t, server: string) {
      return new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>, {
        get(_i, tool: string) {
          return async (args?: Record<string, unknown>) => {
            log(`[dry-run] mcp.${server}.${tool}(${formatArgs(args)})`);
            return undefined;
          };
        },
      });
    },
  });
}

export function createDryRunState(log: DryRunLogger, label: string): AliasStateAccessor {
  return {
    get: async () => undefined,
    all: async () => ({}),
    set: async (key, value) => {
      log(`[dry-run] ${label}.set(${JSON.stringify(key)}, ${formatArgs(value)})`);
    },
    delete: async (key) => {
      log(`[dry-run] ${label}.delete(${JSON.stringify(key)})`);
    },
  };
}

export function wrapDryRunContext(ctx: AliasContext, log: DryRunLogger): AliasContext {
  return {
    ...ctx,
    mcp: createDryRunMcp(log),
    state: createDryRunState(log, "ctx.state"),
    globalState: createDryRunState(log, "ctx.globalState"),
  };
}
