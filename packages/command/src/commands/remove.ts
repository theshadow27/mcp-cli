/**
 * `mcp remove` — unregister an MCP server.
 *
 * Removes a server entry from the config file. The daemon's ConfigWatcher picks up changes.
 */

import { printError } from "../output";
import { type ConfigScope, removeServerFromConfig, resolveConfigPath } from "./config-file";

/**
 * Parse `mcp remove` arguments.
 *
 * Format: mcp remove [--scope {user|project|local}] <name>
 */
export function parseRemoveArgs(args: string[]): { name: string; scope: ConfigScope } {
  let scope: ConfigScope = "user";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" || arg === "-s") {
      const val = args[++i];
      if (val !== "user" && val !== "project" && val !== "local") {
        throw new Error(`Invalid scope "${val}": must be user, project, or local`);
      }
      scope = val;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const name = positional[0];
  if (!name) {
    throw new Error("Server name is required");
  }

  return { name, scope };
}

export async function cmdRemove(args: string[]): Promise<void> {
  if (args.length === 0) {
    printError("Usage: mcp remove [--scope {user|project}] <name>");
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
