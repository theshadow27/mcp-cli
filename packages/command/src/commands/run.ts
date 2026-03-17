/**
 * `mcx run <alias> [json-input] [--key value ...]` — execute an alias script.
 *
 * For defineAlias aliases, the first non-flag argument after the alias name
 * is treated as JSON input (e.g. '{"email": "foo@bar.com"}').
 * --key value pairs are passed as CLI args (available in ctx.args).
 */

import { options as coreOptions, ipcCall, readCliConfig } from "@mcp-cli/core";
import { runAlias } from "../alias-runner";
import { printError } from "../output";

export async function cmdRun(args: string[]): Promise<void> {
  const aliasName = args[0];
  if (!aliasName) {
    printError("Usage: mcx run <alias> [json-input] [--key value ...]");
    process.exit(1);
  }

  const { jsonInput, cliArgs } = parseRunArgs(args.slice(1));

  const aliasInfo = await ipcCall("getAlias", { name: aliasName });
  if (!aliasInfo) {
    printError(`Alias "${aliasName}" not found`);
    process.exit(1);
  }

  // Reset TTL on ephemeral aliases when re-run
  if (aliasInfo.expiresAt) {
    const config = readCliConfig();
    const ttlMs = config.ephemeralAliases?.ttlMs ?? coreOptions.EPHEMERAL_ALIAS_TTL_MS;
    ipcCall("touchAlias", { name: aliasName, expiresAt: Date.now() + ttlMs }).catch(() => {});
  }

  await runAlias(aliasInfo.filePath, cliArgs, jsonInput);
}

/**
 * Parse run arguments: extract optional JSON input (first positional arg)
 * and --key value pairs.
 */
export function parseRunArgs(args: string[]): { jsonInput: string | undefined; cliArgs: Record<string, string> } {
  const cliArgs: Record<string, string> = {};
  let jsonInput: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (i + 1 < args.length) {
        cliArgs[arg.slice(2)] = args[++i];
      }
      // Orphan flags (no following value) are silently ignored
    } else if (jsonInput === undefined) {
      // First non-flag argument is JSON input
      jsonInput = arg;
    }
  }

  return { jsonInput, cliArgs };
}
