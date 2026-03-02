/**
 * `mcp run <alias> [--key value ...]` — execute an alias script.
 */

import type { AliasDetail } from "@mcp-cli/core";
import { runAlias } from "../alias-runner.js";
import { ipcCall } from "../ipc-client.js";
import { printError } from "../output.js";

export async function cmdRun(args: string[]): Promise<void> {
  const aliasName = args[0];
  if (!aliasName) {
    printError("Usage: mcp run <alias> [--key value ...]");
    process.exit(1);
  }

  const cliArgs = parseRunArgs(args.slice(1));

  const aliasInfo = (await ipcCall("getAlias", { name: aliasName })) as AliasDetail | null;
  if (!aliasInfo) {
    printError(`Alias "${aliasName}" not found`);
    process.exit(1);
  }

  await runAlias(aliasInfo.filePath, cliArgs);
}

export function parseRunArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }
  return result;
}
