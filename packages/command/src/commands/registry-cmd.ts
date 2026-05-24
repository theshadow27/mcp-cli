/**
 * `mcx registry` — browse the Anthropic MCP server registry.
 *
 * Subcommands:
 *   mcx registry search <query>   Search by keyword
 *   mcx registry list             List all servers
 */

import { parseFlags } from "../flags";
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
  const { flags, positionals, errors } = parseFlags(args, {
    limit: { type: "number", alias: "n" },
    "no-cache": { type: "boolean" },
  });

  if (errors.length > 0) {
    // Translate parseFlags error format to the original thrown message
    const limitErr = errors.find((e) => e.includes("--limit") || e.includes("-n"));
    if (limitErr) {
      const match = limitErr.match(/got "(.+)"/);
      const raw = match ? match[1] : "";
      throw new Error(`Invalid --limit "${raw}": must be a positive integer`);
    }
    throw new Error(errors[0]);
  }

  const limit = flags.limit as number | undefined;
  if (limit !== undefined && limit <= 0) {
    throw new Error(`Invalid --limit "${limit}": must be a positive integer`);
  }

  return {
    limit,
    noCache: (flags["no-cache"] as boolean) ?? false,
    remaining: positionals,
  };
}
