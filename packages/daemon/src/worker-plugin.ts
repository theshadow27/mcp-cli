/**
 * Shared boilerplate for alias worker threads.
 *
 * Both alias-worker.ts (metadata extraction) and alias-server-worker.ts
 * (MCP server hosting) need the same stubProxy and virtual module
 * registration. This module provides those as reusable pieces.
 */

import type { AliasDefinition, McpProxy } from "@mcp-cli/core";
import { plugin } from "bun";
import { z } from "zod/v4";

/** Stub MCP proxy — returns undefined for any server.tool() call. */
export const stubProxy: McpProxy = new Proxy({} as McpProxy, {
  get() {
    return new Proxy(
      {},
      {
        get() {
          return () => Promise.resolve(undefined);
        },
      },
    );
  },
});

export interface McpPluginOptions {
  /** Plugin name for Bun's plugin registry. */
  name: string;
  /** Called when an alias script invokes defineAlias(). */
  onDefine: (def: AliasDefinition) => void;
  /** Implementations for file/json helpers (stubs for metadata extraction). */
  file: (path: string) => Promise<string>;
  json: (path: string) => Promise<unknown>;
}

/** @internal Build the exports object for the "mcp-cli" virtual module. Exported for testing. */
export function buildMcpExports(opts: Pick<McpPluginOptions, "onDefine" | "file" | "json">) {
  return {
    defineAlias: (defOrFactory: AliasDefinition | ((ctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
      if (typeof defOrFactory === "function") {
        opts.onDefine(defOrFactory({ mcp: stubProxy, z }));
      } else {
        opts.onDefine(defOrFactory);
      }
    },
    z,
    mcp: stubProxy,
    args: {},
    file: opts.file,
    json: opts.json,
  };
}

/** Register the "mcp-cli" virtual module with defineAlias capture. */
export function registerMcpPlugin(opts: McpPluginOptions): void {
  plugin({
    name: opts.name,
    setup(builder) {
      builder.module("mcp-cli", () => ({
        exports: buildMcpExports(opts),
        loader: "object",
      }));
    },
  });
}
