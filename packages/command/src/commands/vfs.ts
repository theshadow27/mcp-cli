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
import {
  CloneCache,
  VfsError,
  clone,
  createAsanaProvider,
  createConfluenceProvider,
  createGitHubIssuesProvider,
  createJiraProvider,
  friendlyMessage,
  pull,
  push,
} from "@mcp-cli/clone";
import type { CloneResult, McpToolCaller } from "@mcp-cli/clone";
import { ipcCall } from "../daemon-lifecycle";
import { printError } from "../output";

export interface VfsDeps {
  clone: typeof clone;
  pull: typeof pull;
  push: typeof push;
  exit: (code: number) => never;
  resolveProvider: (name: string) => ReturnType<typeof createConfluenceProvider>;
  resolveProviderFromCache: (repoDir: string) => {
    provider: ReturnType<typeof createConfluenceProvider>;
    providerName: string;
  };
  preflightCheck: (providerName: string) => Promise<void>;
}

export function makeToolCaller(ipc: typeof ipcCall): McpToolCaller {
  return async (server, tool, args, timeoutMs) => {
    return ipc("callTool", { server, tool, arguments: args }, timeoutMs ? { timeoutMs } : undefined);
  };
}

const callTool = makeToolCaller(ipcCall);
const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Map provider name → the MCP server name it requires. */
export const PROVIDER_SERVER: Record<string, string> = {
  confluence: "atlassian",
  jira: "atlassian",
  asana: "asana",
};

export interface PreflightDeps {
  ipc?: typeof ipcCall;
  exit?: (code: number) => never;
}

/**
 * Preflight check: verify the required MCP server is configured and reachable.
 * Returns normally if OK; throws with an actionable error message if not.
 */
export async function preflightCheck(providerName: string, deps: PreflightDeps = {}): Promise<void> {
  const ipc = deps.ipc ?? ipcCall;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const serverName = PROVIDER_SERVER[providerName];
  if (!serverName) return; // Unknown provider — skip preflight, let it fail normally

  try {
    const servers = (await ipc("listServers", {})) as Array<{ name: string; status?: string }>;
    const server = servers.find((s) => s.name === serverName);

    if (!server) {
      printError(
        `MCP server "${serverName}" is not configured.\n\nThe "${providerName}" provider requires the "${serverName}" MCP server.\nAdd it with:\n\n  mcx add ${serverName}\n\nOr configure it manually in ~/.claude.json or .mcp.json`,
      );
      exit(1);
      return;
    }

    // Verify the server has tools available (i.e., it's connected and responding)
    const tools = (await ipc("listTools", { server: serverName }, { timeoutMs: 10_000 })) as unknown[];
    if (!tools || (Array.isArray(tools) && tools.length === 0)) {
      printError(
        `MCP server "${serverName}" is configured but returned no tools.\n\nThis usually means:\n  - The server failed to start (check: mcx status)\n  - Authentication is needed (check: mcx auth ${serverName})\n  - The server binary is missing or misconfigured\n\nTry restarting: mcx ctl restart ${serverName}`,
      );
      exit(1);
    }
  } catch (err) {
    // If the daemon itself isn't running, listServers will fail — that's a different error
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("not running")) {
      printError(
        "The mcpd daemon is not running.\n\nStart it with:\n\n  mcpd\n\nOr run your command again — mcx auto-starts the daemon.",
      );
      exit(1);
      return;
    }
    // Unexpected error — fail closed rather than proceeding to a confusing double-error
    printError(`Preflight check failed: ${message}`);
    exit(1);
  }
}

export async function cmdVfs(args: string[], opts?: { dryRun?: boolean }, deps?: VfsDeps): Promise<void> {
  const d = deps ?? {
    clone,
    pull,
    push,
    exit: (code: number): never => process.exit(code),
    resolveProvider: (name: string) => resolveProvider(name),
    resolveProviderFromCache: (repoDir: string) => resolveProviderFromCache(repoDir),
    preflightCheck: (name: string) => preflightCheck(name),
  };
  const sub = args[0];

  switch (sub) {
    case "clone":
      await vfsClone(args.slice(1), d);
      break;
    case "pull":
      await vfsPull(args.slice(1), d);
      break;
    case "push":
      await vfsPush(args.slice(1), opts?.dryRun, d);
      break;
    default:
      printUsage();
      if (sub) printError(`Unknown subcommand: "${sub}"`);
      d.exit(1);
  }
}

async function vfsClone(args: string[], deps: VfsDeps): Promise<void> {
  if (args.length < 2) {
    printError("Usage: mcx vfs clone <provider> <scope> [target-dir] [--limit N] [--depth N] [--cloud-id ID]");
    deps.exit(1);
  }

  const providerName = args[0];
  const scopeKey = args[1];
  let targetDir: string | undefined;
  let cloudId: string | undefined;
  let limit = 0;
  let depth = 0;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cloud-id" && args[i + 1]) {
      cloudId = args[++i];
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
    } else if (arg === "--depth" && args[i + 1]) {
      depth = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith("-") && !targetDir) {
      targetDir = arg;
    }
  }

  if (!targetDir) targetDir = `./${scopeKey}`;

  await deps.preflightCheck(providerName);

  const provider = deps.resolveProvider(providerName);
  let result: CloneResult;
  try {
    result = await deps.clone({
      targetDir: resolve(targetDir),
      provider,
      scope: { key: scopeKey, cloudId },
      limit,
      depth,
      onProgress: log,
    });
  } catch (err) {
    if (err instanceof VfsError) {
      printError(friendlyMessage(err, `clone ${providerName}/${scopeKey}`));
      deps.exit(1);
    }
    throw err;
  }

  console.log(
    JSON.stringify(
      {
        provider: providerName,
        space: result.scope.key,
        path: result.path,
        pages: result.pageCount,
        stubs: result.stubCount,
        cloudId: result.scope.cloudId,
        ...(depth > 0 ? { depth } : {}),
      },
      null,
      2,
    ),
  );
}

async function vfsPull(args: string[], deps: VfsDeps): Promise<void> {
  const full = args.includes("--full");
  let depth = 0;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--full") continue;
    if (args[i] === "--depth" && args[i + 1]) {
      depth = Number.parseInt(args[++i], 10);
      continue;
    }
    filteredArgs.push(args[i]);
  }
  const repoDir = resolve(filteredArgs[0] ?? ".");
  const { provider, providerName } = deps.resolveProviderFromCache(repoDir);

  await deps.preflightCheck(providerName);

  try {
    const result = await deps.pull({ repoDir, provider, full, depth, onProgress: log });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof VfsError) {
      printError(friendlyMessage(err, "pull"));
      deps.exit(1);
    }
    throw err;
  }
}

async function vfsPush(args: string[], dryRun: boolean | undefined, deps: VfsDeps): Promise<void> {
  const isCreate = args.includes("--create");
  const filteredArgs = args.filter((a) => a !== "--dry-run" && a !== "--create");
  const isDryRun = dryRun ?? args.includes("--dry-run");
  const repoDir = resolve(filteredArgs[0] ?? ".");
  const { provider, providerName } = deps.resolveProviderFromCache(repoDir);

  await deps.preflightCheck(providerName);

  try {
    const result = await deps.push({ repoDir, provider, dryRun: isDryRun, create: isCreate, onProgress: log });
    console.log(JSON.stringify(result, null, 2));

    if (result.conflicts > 0 || result.errors > 0) {
      deps.exit(1);
    }
  } catch (err) {
    if (err instanceof VfsError) {
      printError(friendlyMessage(err, "push"));
      deps.exit(1);
    }
    throw err;
  }
}

export function onRetry(attempt: number, delayMs: number, error: string, write: (msg: string) => void = log): void {
  const delaySec = (delayMs / 1000).toFixed(1);
  write(`Rate limited (attempt ${attempt}), retrying in ${delaySec}s... (${error})`);
}

export function resolveProvider(name: string) {
  const retry = { onRetry };
  switch (name) {
    case "confluence":
      return createConfluenceProvider({ callTool, retry });
    case "asana":
      return createAsanaProvider({ callTool, retry });
    case "jira":
      return createJiraProvider({ callTool, retry });
    case "github-issues":
      return createGitHubIssuesProvider({ callTool });
    default:
      printError(`Unknown provider: "${name}". Available: confluence, asana, jira, github-issues`);
      process.exit(1);
  }
}

export function resolveProviderFromCache(
  repoDir: string,
  exit: (code: number) => never = (code: number): never => process.exit(code),
): {
  provider: ReturnType<typeof resolveProvider>;
  providerName: string;
} {
  const cachePath = join(repoDir, ".clone", "cache.sqlite");
  if (!existsSync(cachePath)) {
    printError(`Not a cloned repo: ${repoDir}\nUse "mcx vfs clone" first.`);
    exit(1);
  }

  const cache = new CloneCache(cachePath);
  const providerName = cache.findProviderName();
  cache.close();

  if (!providerName) {
    printError("No provider scope found in cache.");
    exit(1);
  }

  return { provider: resolveProvider(providerName as string), providerName: providerName as string };
}

function printUsage(): void {
  process.stderr.write(`mcx vfs — virtual filesystem: clone, sync, and edit remote content locally

Usage:
  mcx vfs clone <provider> <scope> [dir]   Clone remote content as a local git repo
  mcx vfs pull [dir]                       Pull remote changes (incremental)
  mcx vfs pull --full [dir]                Pull all items (detects deletions)
  mcx vfs push [dir]                       Push local changes to the remote
  mcx --dry-run vfs push [dir]             Show what would be pushed

Providers:
  confluence      Clone a Confluence space (scope = space key)
  asana           Clone an Asana project (scope = project GID)
  jira            Clone Jira project issues (scope = project key)
  github-issues   Clone GitHub repo issues (scope = owner/repo)

Options:
  --cloud-id <id>     Cloud/workspace ID (auto-discovered if omitted)
  --depth <n>         Max hierarchy depth to clone (1 = root only, 2 = root + children)
  --limit <n>         Max items to fetch (for testing)
  --full              Force full sync instead of incremental
  --create            Create new remote items from local files (push only)

Examples:
  mcx vfs clone confluence FOO ~/atlassian/foo
  mcx vfs clone confluence FOO ~/atlassian/foo --depth 2
  mcx vfs clone asana 1234567890 ~/asana/my-project
  mcx vfs clone jira FOO ~/jira/foo
  mcx vfs clone github-issues octocat/hello-world ~/github-issues/hello-world
  cd ~/atlassian/foo && mcx vfs pull
  $EDITOR some-page.md && mcx vfs push
`);
}
