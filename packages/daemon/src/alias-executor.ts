/**
 * Alias executor subprocess script.
 *
 * Launched by Bun.spawn from the daemon's alias server to execute
 * alias scripts in an isolated subprocess. Reads bundled JS + input
 * from stdin as JSON, executes via executeAliasBundled(), writes result
 * to stdout as JSON.
 *
 * This provides fault isolation: sync infinite loops, prototype
 * pollution, or crashes kill this subprocess, not the daemon.
 *
 * Supports alias composition: when an alias calls another alias via
 * mcp._aliases.tool(), the proxy makes a real IPC call back to the
 * daemon. A callChain tracks the alias call stack for cycle detection.
 */

import { readFile } from "node:fs/promises";
import {
  type AliasContext,
  type McpProxy,
  createAliasCache,
  executeAliasBundled,
  extractContent,
  ipcCall,
  validateAliasBundled,
} from "@mcp-cli/core";

/** Maximum depth for alias composition to prevent runaway chains. */
const MAX_CALL_DEPTH = 16;

interface ExecutorInput {
  bundledJs: string;
  input: unknown;
  isDefineAlias: boolean;
  mode?: "execute" | "validate";
  aliasName?: string;
  /** Chain of alias names that led to this execution, for cycle detection. */
  callChain?: string[];
}

/**
 * Create a real MCP proxy that calls tools via IPC back to the daemon.
 * For _aliases calls, includes the callChain for cycle detection.
 */
function createExecutorProxy(callChain: string[]): McpProxy {
  return new Proxy({} as McpProxy, {
    get(_target, serverName: string) {
      return new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>, {
        get(_inner, toolName: string) {
          return async (toolArgs?: Record<string, unknown>) => {
            const result = await ipcCall("callTool", {
              server: serverName,
              tool: toolName,
              arguments: toolArgs ?? {},
              callChain,
            });
            return extractContent(result);
          };
        },
      });
    },
  });
}

async function main(): Promise<void> {
  // Redirect console to stderr so alias scripts' console.log doesn't corrupt stdout JSON protocol
  const stderrWrite = (data: string) => process.stderr.write(`${data}\n`);
  console.log = stderrWrite;
  console.warn = stderrWrite;
  console.error = stderrWrite;
  console.info = stderrWrite;
  console.debug = stderrWrite;

  // Read input from stdin
  const stdinText = await Bun.stdin.text();
  const { bundledJs, input, isDefineAlias, mode, aliasName, callChain } = JSON.parse(stdinText) as ExecutorInput;

  if (mode === "validate") {
    const validation = await validateAliasBundled(bundledJs);
    process.stdout.write(JSON.stringify({ result: validation }));
    return;
  }

  const currentAlias = aliasName ?? "unknown";
  const chain = callChain ?? [];

  // Cycle detection: check if this alias is already in the call chain
  if (chain.includes(currentAlias)) {
    throw new Error(`Alias cycle detected: ${[...chain, currentAlias].join(" → ")}`);
  }

  // Depth limit
  if (chain.length >= MAX_CALL_DEPTH) {
    throw new Error(`Alias call chain too deep (max ${MAX_CALL_DEPTH}): ${[...chain, currentAlias].join(" → ")}`);
  }

  // Build the updated chain including the current alias
  const updatedChain = [...chain, currentAlias];

  const ctx: AliasContext = {
    mcp: createExecutorProxy(updatedChain),
    args:
      typeof input === "object" && input !== null
        ? Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    file: (path: string) => readFile(path, "utf-8"),
    json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
    cache: createAliasCache(currentAlias),
  };

  const result = await executeAliasBundled(bundledJs, input, ctx, isDefineAlias);
  process.stdout.write(JSON.stringify({ result: result ?? null }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
