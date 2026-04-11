import { existsSync } from "node:fs";
/**
 * `mcx pull` — pull remote changes into a cloned repo.
 *
 * Usage:
 *   mcx pull              — pull in current directory
 *   mcx pull <dir>        — pull in specified directory
 */
import { resolve } from "node:path";
import { join } from "node:path";
import { pull } from "@mcp-cli/clone";
import { CloneCache } from "@mcp-cli/clone/engine/cache";
import { createConfluenceProvider } from "@mcp-cli/clone/providers/confluence";
import type { McpToolCaller } from "@mcp-cli/clone/providers/confluence";
import { ipcCall } from "../daemon-lifecycle";
import { printError } from "../output";

function makeToolCaller(ipc: typeof ipcCall): McpToolCaller {
  return async (server, tool, args, timeoutMs) => {
    return ipc("callTool", { server, tool, arguments: args }, timeoutMs ? { timeoutMs } : undefined);
  };
}

export async function cmdPull(args: string[]): Promise<void> {
  const repoDir = resolve(args[0] ?? ".");
  const cachePath = join(repoDir, ".clone", "cache.sqlite");

  if (!existsSync(cachePath)) {
    printError(`Not a cloned repo: ${repoDir}\nUse "mcx clone" to create one.`);
    process.exit(1);
  }

  // Detect provider from cache
  const cache = new CloneCache(cachePath);
  const scope = cache.findFirstScope("confluence");
  cache.close();

  if (!scope) {
    printError("No Confluence scope found in cache.");
    process.exit(1);
  }

  const callTool = makeToolCaller(ipcCall);
  const provider = createConfluenceProvider({ callTool });

  const result = await pull({
    repoDir,
    provider,
    onProgress: (msg) => process.stderr.write(`${msg}\n`),
  });

  console.log(JSON.stringify(result, null, 2));
}
