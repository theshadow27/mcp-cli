/**
 * `mcx registry` — browse the Anthropic MCP server registry.
 *
 * Subcommands:
 *   mcx registry search <query>   Search by keyword
 *   mcx registry list             List all servers
 */

import { printError, printRegistryList } from "../output";
import { extractJsonFlag } from "../parse";
import { listRegistry, searchRegistry } from "../registry/client";

export async function cmdRegistryDispatch(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "search":
      await cmdRegistrySearch(args.slice(1));
      break;
    case "list":
    case undefined:
      await cmdRegistryList(args.slice(sub ? 1 : 0));
      break;
    default:
      printError("Usage: mcx registry {search|list} [--limit N] [--json]");
      process.exit(1);
  }
}

async function cmdRegistrySearch(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const { limit, noCache, remaining } = extractRegistryFlags(rest);

  const query = remaining.join(" ");
  if (!query) {
    printError("Usage: mcx registry search <query>");
    process.exit(1);
  }

  const result = await searchRegistry(query, { limit, noCache });
  if (json) {
    console.log(JSON.stringify(result.servers, null, 2));
  } else {
    printRegistryList(result.servers);
  }
}

async function cmdRegistryList(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const { limit, noCache } = extractRegistryFlags(rest);

  const result = await listRegistry({ limit, noCache });
  if (json) {
    console.log(JSON.stringify(result.servers, null, 2));
  } else {
    printRegistryList(result.servers);
  }
}

/** @internal Exported for testing. */
export function extractRegistryFlags(args: string[]): {
  limit: number | undefined;
  noCache: boolean;
  remaining: string[];
} {
  const remaining: string[] = [];
  let limit: number | undefined;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--limit" || args[i] === "-n") && i + 1 < args.length) {
      limit = Number.parseInt(args[i + 1], 10);
      if (Number.isNaN(limit) || limit <= 0) {
        throw new Error(`Invalid --limit "${args[i + 1]}": must be a positive integer`);
      }
      i++;
    } else if (args[i] === "--no-cache") {
      noCache = true;
    } else {
      remaining.push(args[i]);
    }
  }

  return { limit, noCache, remaining };
}
