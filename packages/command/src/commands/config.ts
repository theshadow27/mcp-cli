/**
 * `mcp config` commands — display resolved configuration and sources.
 */

import type { GetConfigResult } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { printError } from "../output.js";

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
};

export async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";

  switch (sub) {
    case "show":
      await configShow();
      break;
    case "sources":
      await configSources();
      break;
    default:
      printError(`Unknown config subcommand: ${sub}. Use "show" or "sources".`);
      process.exit(1);
  }
}

async function configShow(): Promise<void> {
  const config = (await ipcCall("getConfig")) as GetConfigResult;
  const entries = Object.entries(config.servers);

  if (entries.length === 0) {
    console.error("No servers configured.");
    return;
  }

  const maxName = Math.max(...entries.map(([n]) => n.length));

  for (const [name, info] of entries) {
    console.log(
      `  ${c.cyan}${name.padEnd(maxName)}${c.reset}  ${c.dim}${info.transport.padEnd(6)}${c.reset}  ${info.toolCount > 0 ? `${info.toolCount} tools` : ""}  ${c.dim}${info.scope}:${info.source}${c.reset}`,
    );
  }
  console.log(`\n${entries.length} server(s) from ${config.sources.length} source(s)`);
}

async function configSources(): Promise<void> {
  const config = (await ipcCall("getConfig")) as GetConfigResult;

  if (config.sources.length === 0) {
    console.error("No config sources found.");
    return;
  }

  console.log(`${c.bold}Config sources${c.reset} (highest priority last):\n`);
  for (const source of config.sources) {
    console.log(`  ${c.yellow}${source.scope.padEnd(10)}${c.reset}  ${source.file}`);
  }
}
