import { existsSync } from "node:fs";
/**
 * `mcx push` — push local changes to the remote provider.
 *
 * Usage:
 *   mcx push              — push from current directory
 *   mcx push <dir>        — push from specified directory
 *   mcx push --dry-run    — show what would be pushed
 */
import { resolve } from "node:path";
import { join } from "node:path";
import { push } from "@mcp-cli/clone";
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

export async function cmdPush(args: string[], opts?: { dryRun?: boolean }): Promise<void> {
  const dryRun = opts?.dryRun ?? args.includes("--dry-run");
  const filteredArgs = args.filter((a) => a !== "--dry-run");
  const repoDir = resolve(filteredArgs[0] ?? ".");
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

  const result = await push({
    repoDir,
    provider,
    dryRun,
    onProgress: (msg) => process.stderr.write(`${msg}\n`),
  });

  console.log(JSON.stringify(result, null, 2));

  // Exit with error code if there were conflicts or errors
  if (result.conflicts > 0 || result.errors > 0) {
    process.exit(1);
  }
}
