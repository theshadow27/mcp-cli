/**
 * `mcp registry` — browse the Anthropic MCP server registry.
 *
 * Subcommands:
 *   mcp registry search <query>   Search by keyword
 *   mcp registry list             List all servers
 */

import { printError, printRegistryList } from "../output.js";
import { extractJsonFlag } from "../parse.js";
import { listRegistry, searchRegistry } from "../registry/client.js";

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
      printError("Usage: mcp registry {search|list} [--limit N] [--json]");
      process.exit(1);
  }
}

async function cmdRegistrySearch(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const { limit, remaining } = extractLimit(rest);

  const query = remaining.join(" ");
  if (!query) {
    printError("Usage: mcp registry search <query>");
    process.exit(1);
  }

  const result = await searchRegistry(query, { limit });
  if (json) {
    console.log(JSON.stringify(result.servers, null, 2));
  } else {
    printRegistryList(result.servers);
  }
}

async function cmdRegistryList(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const { limit } = extractLimit(rest);

  const result = await listRegistry({ limit });
  if (json) {
    console.log(JSON.stringify(result.servers, null, 2));
  } else {
    printRegistryList(result.servers);
  }
}

function extractLimit(args: string[]): { limit: number | undefined; remaining: string[] } {
  const remaining: string[] = [];
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--limit" || args[i] === "-n") && i + 1 < args.length) {
      limit = Number.parseInt(args[i + 1], 10);
      i++;
    } else {
      remaining.push(args[i]);
    }
  }

  return { limit, remaining };
}
