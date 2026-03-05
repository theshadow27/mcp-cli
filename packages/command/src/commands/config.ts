/**
 * `mcp config` commands — display resolved configuration and sources,
 * plus get/set for CLI options like trust-claude.
 */

import type { GetConfigResult } from "@mcp-cli/core";
import { ipcCall, readCliConfig, writeCliConfig } from "@mcp-cli/core";
import { c, printError } from "../output";

export async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";

  switch (sub) {
    case "show":
      await configShow();
      break;
    case "sources":
      await configSources();
      break;
    case "set":
      configSet(args.slice(1));
      break;
    case "get":
      configGet(args.slice(1));
      break;
    default:
      printError(`Unknown config subcommand: ${sub}. Use "show", "sources", "set", or "get".`);
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

const VALID_KEYS = ["trust-claude"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

/** Map CLI key names (kebab-case) to CliConfig property names (camelCase). */
const KEY_MAP: Record<ConfigKey, "trustClaude"> = {
  "trust-claude": "trustClaude",
};

function configSet(args: string[]): void {
  const [key, value] = args;
  if (!key || value === undefined) {
    printError("Usage: mcp config set <key> <value>");
    process.exit(1);
  }
  if (!VALID_KEYS.includes(key as ConfigKey)) {
    printError(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }
  const prop = KEY_MAP[key as ConfigKey];
  const config = readCliConfig();
  config[prop] = value === "true";
  writeCliConfig(config);
  console.log(`${key} = ${config[prop]}`);
}

function configGet(args: string[]): void {
  const key = args[0];
  if (!key) {
    printError("Usage: mcp config get <key>");
    process.exit(1);
  }
  if (!VALID_KEYS.includes(key as ConfigKey)) {
    printError(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }
  const prop = KEY_MAP[key as ConfigKey];
  const config = readCliConfig();
  console.log(String(config[prop] ?? false));
}
