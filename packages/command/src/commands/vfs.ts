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
  DEFAULT_BATCH_SIZE,
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
import type { CloneResult, McpToolCaller, VfsProgressSink } from "@mcp-cli/clone";
import { ipcCall as coreIpcCall } from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";
import { printError } from "../output";

/** Per-invocation provider tuning sourced from CLI flags. */
export interface ProviderTuning {
  /** Upper bound on items per page request; batches adapt downward on rate limiting. */
  batchSize?: number;
}

/** Largest page size the Confluence v2 API accepts — single source is the provider. */
export const MAX_BATCH_SIZE = DEFAULT_BATCH_SIZE;

export interface VfsDeps {
  clone: typeof clone;
  pull: typeof pull;
  push: typeof push;
  exit: (code: number) => never;
  resolveProvider: (name: string, opts?: ProviderTuning) => ReturnType<typeof createConfluenceProvider>;
  resolveProviderFromCache: (repoDir: string) => {
    provider: ReturnType<typeof createConfluenceProvider>;
    providerName: string;
  };
  preflightCheck: (providerName: string) => Promise<void>;
  /** Progress sink for clone/pull. Defaults to the daemon event bus (#1249). */
  onEvent?: VfsProgressSink;
}

/**
 * Ceiling on one telemetry publish, enforced locally by
 * {@link makeProgressPublisher}. A wedged daemon must not be able to stall a
 * clone on its own progress.
 */
export const PROGRESS_PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Forward clone/pull progress onto the daemon event bus, so `mcx monitor` can
 * follow a long clone running in another terminal.
 *
 * Best-effort, which means *swallow the error* — not *skip the await*. `main()`
 * resolving calls `process.exit()`, which tears down the event loop before an
 * un-awaited socket write lands, so a fire-and-forget publish silently drops the
 * terminal `vfs.completed` / `vfs.failed` event (#2983).
 *
 * Two things this deliberately does *not* do:
 *
 * 1. **It does not call `daemon-lifecycle`'s `ipcCall`.** That one runs
 *    `ensureDaemon()` first, which is outside `opts.timeoutMs` (#3151) and can
 *    sit for ~15s on a daemon that holds its PID flock but does not answer its
 *    socket — measured 15,212ms against a documented 2,000ms ceiling. Worse,
 *    its wait path `unlink`s the daemon lock file, so routing telemetry through
 *    it would mutate daemon-lifecycle state 20+ times per clone instead of once
 *    per command, and could delete the lock out from under another `mcx`
 *    inside its `O_EXCL` startup window. Telemetry must be strictly
 *    observational: the core client talks to the socket and nothing else, and
 *    "no daemon" is simply a rejection we swallow.
 * 2. **It does not delegate the ceiling to the callee.** A constant named as a
 *    bound has to bound the operation it names whatever the callee does, so the
 *    race below is the guarantee — `timeoutMs` is passed as well, but it is
 *    defence in depth rather than the mechanism.
 */
export function makeProgressPublisher(
  ipc: typeof coreIpcCall = coreIpcCall,
  timeoutMs: number = PROGRESS_PUBLISH_TIMEOUT_MS,
): VfsProgressSink {
  return async ({ event, ...fields }) => {
    // Settled to `void` on both paths: once the race is lost nobody is awaiting
    // this promise, and a late rejection would surface as an unhandled one.
    const publish = Promise.resolve(
      ipc("publishEvent", { src: "cli.vfs", event, category: "vfs", extra: { ...fields } }, { timeoutMs }),
    ).then(
      () => {},
      () => {},
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        publish,
        new Promise<void>((settle) => {
          timer = setTimeout(settle, timeoutMs);
        }),
      ]);
    } finally {
      // Don't leave a 2s timer holding the loop open after a fast publish.
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export function makeToolCaller(ipc: typeof ipcCall): McpToolCaller {
  return async (server, tool, args, timeoutMs) => {
    return ipc("callTool", { server, tool, arguments: args }, timeoutMs ? { timeoutMs } : undefined);
  };
}

const callTool = makeToolCaller(ipcCall);
const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Preflight `listTools` probe — server may need a few seconds to spin up and respond. */
const LIST_TOOLS_PREFLIGHT_TIMEOUT_MS = 10_000;

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
    const tools = (await ipc(
      "listTools",
      { server: serverName },
      { timeoutMs: LIST_TOOLS_PREFLIGHT_TIMEOUT_MS },
    )) as unknown[];
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
    resolveProvider: (name: string, tuning?: ProviderTuning) => resolveProvider(name, tuning),
    resolveProviderFromCache: (repoDir: string) => resolveProviderFromCache(repoDir),
    preflightCheck: (name: string) => preflightCheck(name),
    onEvent: makeProgressPublisher(),
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
    printError(
      "Usage: mcx vfs clone <provider> <scope> [target-dir] [--limit N] [--depth N] [--batch-size N] [--cloud-id ID]",
    );
    deps.exit(1);
  }

  const providerName = args[0];
  const scopeKey = args[1];

  const { flags, positionals, errors } = parseFlags(args.slice(2), {
    "cloud-id": { type: "string" },
    limit: { type: "number" },
    depth: { type: "number" },
    "batch-size": { type: "number" },
  });
  if (errors.length > 0) {
    printError(errors[0]);
    deps.exit(1);
  }

  const cloudId = flags["cloud-id"] as string | undefined;
  const limitRaw = flags.limit as number | undefined;
  const depthRaw = flags.depth as number | undefined;
  if (limitRaw !== undefined && !Number.isInteger(limitRaw)) {
    printError(`--limit requires an integer, got: ${limitRaw}`);
    deps.exit(1);
  }
  if (depthRaw !== undefined && !Number.isInteger(depthRaw)) {
    printError(`--depth requires an integer, got: ${depthRaw}`);
    deps.exit(1);
  }
  const batchSize = flags["batch-size"] as number | undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE)) {
    printError(`--batch-size requires an integer between 1 and ${MAX_BATCH_SIZE}, got: ${batchSize}`);
    deps.exit(1);
  }
  const limit = limitRaw ?? 0;
  const depth = depthRaw ?? 0;
  const targetDir = positionals[0] ?? `./${scopeKey}`;

  await deps.preflightCheck(providerName);

  const provider = deps.resolveProvider(providerName, { batchSize });
  let result: CloneResult;
  try {
    result = await deps.clone({
      targetDir: resolve(targetDir),
      provider,
      scope: { key: scopeKey, cloudId },
      limit,
      depth,
      onProgress: log,
      onEvent: deps.onEvent,
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
  log(
    'Warning: "mcx vfs pull" is deprecated. Use "git pull" instead.\n         The command will be removed in a future release.',
  );
  const { flags, positionals, errors } = parseFlags(args, {
    full: { type: "boolean" },
    depth: { type: "number" },
  });
  if (errors.length > 0) {
    printError(errors[0]);
    deps.exit(1);
  }

  const full = (flags.full as boolean) ?? false;
  const depthRaw = flags.depth as number | undefined;
  if (depthRaw !== undefined && !Number.isInteger(depthRaw)) {
    printError(`--depth requires an integer, got: ${depthRaw}`);
    deps.exit(1);
  }
  const depth = depthRaw ?? 0;
  const repoDir = resolve(positionals[0] ?? ".");
  const { provider, providerName } = deps.resolveProviderFromCache(repoDir);

  await deps.preflightCheck(providerName);

  try {
    const result = await deps.pull({ repoDir, provider, full, depth, onProgress: log, onEvent: deps.onEvent });
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
  log(
    'Warning: "mcx vfs push" is deprecated. Use "git push" instead.\n         The command will be removed in a future release.',
  );
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

export function resolveProvider(name: string, tuning?: ProviderTuning) {
  const retry = { onRetry };
  switch (name) {
    case "confluence":
      return createConfluenceProvider({ callTool, retry, batchSize: tuning?.batchSize });
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
  --batch-size <n>    Max items per page request (clone only; 1-250, default 250;
                      shrinks automatically when the remote rate-limits, and is
                      not persisted — later pulls start from the default again)
  --full              Force full sync instead of incremental
  --create            Create new remote items from local files (push only)

Progress:
  clone and pull print live progress to stderr ("Fetching FOO... 250/5000 pages
  (5%)") and publish vfs.started, vfs.progress and a terminal vfs.completed or
  vfs.failed on the daemon event bus. Follow a long clone from another terminal
  with: mcx monitor
  A run killed by a signal (Ctrl-C) leaves its stream open — a waiter needs its
  own timeout as a backstop.
  Every event carries repoRoot (the target dir), so repo-scoped monitors stay
  unpolluted, and a runId that tags the run in the stream. Note that monitor
  filters cannot yet select on runId (#3153).
  The percentage needs a provider that can count its scope up front (confluence);
  others report a bare item count.

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
