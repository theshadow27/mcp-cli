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
  type AliasWorkItemInfo,
  GLOBAL_STATE_NAMESPACE,
  type McpProxy,
  NO_REPO_ROOT,
  aliasUserNamespace,
  createAliasCache,
  createAliasState,
  createWaitForEvent,
  executeAliasBundled,
  extractContent,
  extractMonitorMetadata,
  findGitRoot,
  ipcCall,
  validateAliasBundled,
} from "@mcp-cli/core";

/**
 * Why workItem is resolved by the *daemon* (in alias-server.ts) and passed in
 * via the payload rather than looked up here:
 *
 *   1. No re-entrant IPC. An alias invocation would otherwise open a new
 *      connection to the daemon's Unix socket to ask the daemon a question
 *      the daemon already knows the answer to.
 *   2. No git subprocess spawn on the hot path. The daemon resolves the
 *      branch once, using its own process, and can memoize cheaply.
 *   3. Predictable <50ms startup budget (see CLAUDE.md) — avoids a 3s
 *      symbolic-ref timeout hanging every alias call on a flaky filesystem.
 *
 * The executor must still tolerate a missing workItem (legacy callers, the
 * alias-server-worker virtual-module path, or calls with no cwd).
 */

/** Maximum depth for alias composition to prevent runaway chains. */
const MAX_CALL_DEPTH = 16;

interface ExecutorInput {
  bundledJs: string;
  input: unknown;
  isDefineAlias: boolean;
  mode?: "execute" | "validate" | "extractMonitors";
  aliasName?: string;
  /** Chain of alias names that led to this execution, for cycle detection. */
  callChain?: string[];
  /** Caller's working directory used to resolve repo root for ctx.state. */
  cwd?: string;
  /**
   * Work item backing the invocation, pre-resolved by the daemon. The
   * executor subprocess never opens an IPC connection back to the daemon
   * for this — see the module-level comment for why.
   */
  workItem?: AliasWorkItemInfo | null;
}

/**
 * Create a real MCP proxy that calls tools via IPC back to the daemon.
 * For _aliases calls, includes the callChain for cycle detection and the
 * original caller's cwd so nested aliases scope state to the same repo.
 */
function createExecutorProxy(callChain: string[], cwd: string | undefined): McpProxy {
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
              ...(cwd ? { cwd } : {}),
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
  const { bundledJs, input, isDefineAlias, mode, aliasName, callChain, cwd, workItem } = JSON.parse(
    stdinText,
  ) as ExecutorInput;

  if (mode === "validate") {
    const validation = await validateAliasBundled(bundledJs);
    process.stdout.write(JSON.stringify({ result: validation }));
    return;
  }

  if (mode === "extractMonitors") {
    const monitors = await extractMonitorMetadata(bundledJs);
    process.stdout.write(JSON.stringify({ result: monitors }));
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

  // Scope state to the caller's repo — NOT the daemon's cwd. Without an
  // explicit cwd from the caller, every alias invocation via the MCP server
  // would collapse into the NO_REPO_ROOT bucket (see PR #1307 review).
  const repoRoot = cwd ? (findGitRoot(cwd) ?? NO_REPO_ROOT) : NO_REPO_ROOT;
  const ctx: AliasContext = {
    mcp: createExecutorProxy(updatedChain, cwd),
    args:
      typeof input === "object" && input !== null
        ? Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    file: (path: string) => readFile(path, "utf-8"),
    json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
    cache: createAliasCache(currentAlias),
    state: createAliasState({ repoRoot, namespace: aliasUserNamespace(currentAlias) }),
    globalState: createAliasState({ repoRoot, namespace: GLOBAL_STATE_NAMESPACE }),
    workItem: workItem ?? null,
    waitForEvent: createWaitForEvent(),
  };

  const result = await executeAliasBundled(bundledJs, input, ctx, isDefineAlias);
  process.stdout.write(JSON.stringify({ result: result ?? null }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
