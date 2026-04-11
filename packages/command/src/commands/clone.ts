/**
 * `mcx clone` — clone a remote provider's scope into a local git repo.
 *
 * Usage:
 *   mcx clone confluence <space-key> [target-dir]  — clone a Confluence space
 *   mcx clone confluence FOO ~/atlassian/foo
 *   mcx clone confluence FOO                       — clones to ./<space-key>
 *
 * Options:
 *   --cloud-id <id>     Atlassian cloud ID (auto-discovered if omitted)
 *   --limit <n>         Max pages to fetch (for testing)
 */
import { resolve } from "node:path";
import { clone } from "@mcp-cli/clone";
import { createConfluenceProvider } from "@mcp-cli/clone/providers/confluence";
import type { McpToolCaller } from "@mcp-cli/clone/providers/confluence";
import { ipcCall } from "../daemon-lifecycle";
import { printError } from "../output";

/** Adapt the typed ipcCall to the generic McpToolCaller signature. */
function makeToolCaller(ipc: typeof ipcCall): McpToolCaller {
  return async (server, tool, args, timeoutMs) => {
    return ipc("callTool", { server, tool, arguments: args }, timeoutMs ? { timeoutMs } : undefined);
  };
}

export interface CloneDeps {
  callTool: McpToolCaller;
  log: (msg: string) => void;
}

const defaultDeps: CloneDeps = {
  callTool: makeToolCaller(ipcCall),
  log: (msg) => process.stderr.write(`${msg}\n`),
};

export async function cmdClone(args: string[], deps: CloneDeps = defaultDeps): Promise<void> {
  if (args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const providerName = args[0];
  const scopeKey = args[1];

  // Parse remaining args
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

  // Default target dir to ./<scope-key>
  if (!targetDir) targetDir = `./${scopeKey}`;

  switch (providerName) {
    case "confluence": {
      const provider = createConfluenceProvider({
        callTool: deps.callTool,
      });

      const result = await clone({
        targetDir: resolve(targetDir),
        provider,
        scope: { key: scopeKey, cloudId },
        limit,
        onProgress: deps.log,
      });

      // Summary to stdout (JSON for composability)
      console.log(
        JSON.stringify(
          {
            provider: "confluence",
            space: result.scope.key,
            path: result.path,
            pages: result.pageCount,
            cloudId: result.scope.cloudId,
          },
          null,
          2,
        ),
      );
      break;
    }

    default:
      printError(`Unknown provider: "${providerName}". Available providers: confluence`);
      process.exit(1);
  }
}

function printUsage(): void {
  process.stderr.write(`Usage: mcx clone <provider> <scope> [target-dir] [options]

Providers:
  confluence    Clone a Confluence space

Examples:
  mcx clone confluence FOO ~/atlassian/foo
  mcx clone confluence FOO --limit 10
  mcx clone confluence FOO --cloud-id e46ec1c4-...

Options:
  --cloud-id <id>     Atlassian cloud ID (auto-discovered if omitted)
  --limit <n>         Max pages to fetch (for testing)
`);
}
