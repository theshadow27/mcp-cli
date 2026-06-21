/**
 * Read/write helpers for ~/.mcp-cli/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CliConfig } from "./config";
import { options } from "./constants";

/** Read the CLI config file. Returns `{}` if missing or malformed. */
export function readCliConfig(): CliConfig {
  try {
    const text = readFileSync(options.MCP_CLI_CONFIG_PATH, "utf-8");
    const config = JSON.parse(text) as CliConfig;
    const pruned = pruneStalePromptedDirs(config);
    if (pruned !== config) {
      try {
        writeCliConfig(pruned);
      } catch {
        // Reading config should remain best-effort even if GC persistence fails.
      }
    }
    return pruned;
  } catch {
    return {};
  }
}

function pruneStalePromptedDirs(config: CliConfig): CliConfig {
  if (!config.promptedDirs) return config;

  const promptedDirs = config.promptedDirs.filter((dir) => typeof dir === "string" && existsSync(dir));
  if (promptedDirs.length === config.promptedDirs.length) return config;

  return {
    ...config,
    promptedDirs,
  };
}

/** Write the CLI config file, creating the parent directory if needed. */
export function writeCliConfig(config: CliConfig): void {
  const dir = dirname(options.MCP_CLI_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(options.MCP_CLI_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
