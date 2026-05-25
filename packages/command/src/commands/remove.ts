/**
 * `mcx remove` — unregister an MCP server.
 *
 * Removes a server entry from the config file. The daemon's ConfigWatcher picks up changes.
 */

import { parseFlags } from "../flags";
import { printError } from "../output";
import { parseScope } from "../parse";
import { CONFIG_SCOPES, type ConfigScope, removeServerFromConfig, resolveConfigPath } from "./config-file";

/**
 * Parse `mcx remove` arguments.
 *
 * Format: mcx remove [--scope {user|project|local}] <name>
 */
export function parseRemoveArgs(args: string[]): { name: string; scope: ConfigScope } {
  const { flags, positionals, errors } = parseFlags(args, {
    scope: { type: "string", alias: "s" },
  });

  if (errors.length > 0) throw new Error(errors[0]);

  const scope: ConfigScope = flags.scope ? parseScope(flags.scope as string, CONFIG_SCOPES) : "user";

  const name = positionals[0];
  if (!name) {
    throw new Error("Server name is required");
  }

  return { name, scope };
}

export async function cmdRemove(args: string[]): Promise<void> {
  if (args.length === 0) {
    printError("Usage: mcx remove [--scope {user|project}] <name>");
    process.exit(1);
  }

  const { name, scope } = parseRemoveArgs(args);
  const removed = removeServerFromConfig(scope, name);
  const path = resolveConfigPath(scope);

  if (!removed) {
    printError(`Server "${name}" not found in ${path}`);
    process.exit(1);
  }

  console.error(`Removed server "${name}" from ${path}`);
}
