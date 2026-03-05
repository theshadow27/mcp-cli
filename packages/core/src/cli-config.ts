/**
 * Read/write helpers for ~/.mcp-cli/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CliConfig } from "./config.js";
import { options } from "./constants.js";

/** Read the CLI config file. Returns `{}` if missing or malformed. */
export function readCliConfig(): CliConfig {
  try {
    const text = readFileSync(options.MCP_CLI_CONFIG_PATH, "utf-8");
    return JSON.parse(text) as CliConfig;
  } catch {
    return {};
  }
}

/** Write the CLI config file, creating the parent directory if needed. */
export function writeCliConfig(config: CliConfig): void {
  const dir = dirname(options.MCP_CLI_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(options.MCP_CLI_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
