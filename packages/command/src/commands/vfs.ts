/**
 * `mcx vfs` — virtual filesystem: clone, pull, and push remote content as local git repos.
 *
 * Usage:
 *   mcx vfs clone confluence <space> [dir]   Clone a Confluence space
 *   mcx vfs pull [dir]                       Pull remote changes
 *   mcx vfs push [dir]                       Push local changes
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CloneCache, clone, createConfluenceProvider, pull, push } from "@mcp-cli/clone";
import type { McpToolCaller } from "@mcp-cli/clone";
import { ipcCall } from "../daemon-lifecycle";
import { printError } from "../output";

function makeToolCaller(ipc: typeof ipcCall): McpToolCaller {
  return async (server, tool, args, timeoutMs) => {
    return ipc("callTool", { server, tool, arguments: args }, timeoutMs ? { timeoutMs } : undefined);
  };
}

const callTool = makeToolCaller(ipcCall);
const log = (msg: string) => process.stderr.write(`${msg}\n`);

export async function cmdVfs(args: string[], opts?: { dryRun?: boolean }): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "clone":
      await vfsClone(args.slice(1));
      break;
    case "pull":
      await vfsPull(args.slice(1));
      break;
    case "push":
      await vfsPush(args.slice(1), opts?.dryRun);
      break;
    default:
      printUsage();
      if (sub) printError(`Unknown subcommand: "${sub}"`);
      process.exit(1);
  }
}

async function vfsClone(args: string[]): Promise<void> {
  if (args.length < 2) {
    printError("Usage: mcx vfs clone <provider> <scope> [target-dir] [--limit N] [--cloud-id ID]");
    process.exit(1);
  }

  const providerName = args[0];
  const scopeKey = args[1];
  let targetDir: string | undefined;
  let cloudId: string | undefined;
  let limit = 0;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cloud-id" && args[i + 1]) {
      cloudId = args[++i];
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith("-") && !targetDir) {
      targetDir = arg;
    }
  }

  if (!targetDir) targetDir = `./${scopeKey}`;

  const provider = resolveProvider(providerName);
  const result = await clone({
    targetDir: resolve(targetDir),
    provider,
    scope: { key: scopeKey, cloudId },
    limit,
    onProgress: log,
  });

  console.log(
    JSON.stringify(
      {
        provider: providerName,
        space: result.scope.key,
        path: result.path,
        pages: result.pageCount,
        cloudId: result.scope.cloudId,
      },
      null,
      2,
    ),
  );
}

async function vfsPull(args: string[]): Promise<void> {
  const full = args.includes("--full");
  const filteredArgs = args.filter((a) => a !== "--full");
  const repoDir = resolve(filteredArgs[0] ?? ".");
  const provider = resolveProviderFromCache(repoDir);

  const result = await pull({ repoDir, provider, full, onProgress: log });
  console.log(JSON.stringify(result, null, 2));
}

async function vfsPush(args: string[], dryRun?: boolean): Promise<void> {
  const isCreate = args.includes("--create");
  const filteredArgs = args.filter((a) => a !== "--dry-run" && a !== "--create");
  const isDryRun = dryRun ?? args.includes("--dry-run");
  const repoDir = resolve(filteredArgs[0] ?? ".");
  const provider = resolveProviderFromCache(repoDir);

  const result = await push({ repoDir, provider, dryRun: isDryRun, create: isCreate, onProgress: log });
  console.log(JSON.stringify(result, null, 2));

  if (result.conflicts > 0 || result.errors > 0) {
    process.exit(1);
  }
}

function resolveProvider(name: string) {
  switch (name) {
    case "confluence":
      return createConfluenceProvider({ callTool });
    default:
      printError(`Unknown provider: "${name}". Available: confluence`);
      process.exit(1);
  }
}

function resolveProviderFromCache(repoDir: string) {
  const cachePath = join(repoDir, ".clone", "cache.sqlite");
  if (!existsSync(cachePath)) {
    printError(`Not a cloned repo: ${repoDir}\nUse "mcx vfs clone" first.`);
    process.exit(1);
  }

  const cache = new CloneCache(cachePath);
  const scope = cache.findFirstScope("confluence");
  cache.close();

  if (!scope) {
    printError("No provider scope found in cache.");
    process.exit(1);
  }

  // For now, only Confluence. Extend when more providers land.
  return createConfluenceProvider({ callTool });
}

function printUsage(): void {
  process.stderr.write(`mcx vfs — virtual filesystem: clone, sync, and edit remote content locally

Usage:
  mcx vfs clone confluence <space> [dir]   Clone a Confluence space as a local git repo
  mcx vfs pull [dir]                       Pull remote changes (incremental)
  mcx vfs pull --full [dir]                Pull all pages (detects deletions)
  mcx vfs push [dir]                       Push local changes to the remote
  mcx --dry-run vfs push [dir]             Show what would be pushed

Options:
  --cloud-id <id>     Atlassian cloud ID (auto-discovered if omitted)
  --limit <n>         Max pages to fetch (for testing)
  --full              Force full sync instead of incremental

Examples:
  mcx vfs clone confluence FOO ~/atlassian/foo
  cd ~/atlassian/foo && mcx vfs pull
  $EDITOR some-page.md && mcx vfs push
`);
}
