/**
 * Read/write helpers for ~/.mcp-cli/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CliConfig } from "./config";
import { options } from "./constants";

/**
 * Read the CLI config file. Returns `{}` if missing or malformed.
 *
 * `onWarn` fires only for a file that EXISTS and could not be used — a missing
 * config is the normal state and says nothing. Callers whose behaviour changes
 * on a silently-empty config should pass it: a corrupt `config.json` voids every
 * key at once (`defaultProfile` included, #935), and a machine-wide downgrade
 * with no diagnostic is indistinguishable from the feature not working.
 */
export function readCliConfig(onWarn?: (message: string) => void): CliConfig {
  let text: string;
  try {
    text = readFileSync(options.MCP_CLI_CONFIG_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      onWarn?.(
        `${options.MCP_CLI_CONFIG_PATH}: unreadable (${code ?? "unknown error"}) — every config key is being ignored`,
      );
    }
    return {};
  }
  try {
    return JSON.parse(text) as CliConfig;
  } catch (err) {
    onWarn?.(
      `${options.MCP_CLI_CONFIG_PATH}: is not valid JSON (${(err as Error).message}) — every config key is being ignored`,
    );
    return {};
  }
}

/**
 * Drop promptedDirs entries whose path no longer exists on disk.
 *
 * Worktrees are torn down at session `bye` but their first-run prompt markers
 * linger forever, so the list grows unbounded (#2660). Pruning on write keeps
 * it bounded to directories that still exist.
 */
export function prunePromptedDirs(dirs: string[]): string[] {
  return dirs.filter((dir) => existsSync(dir));
}

/** Write the CLI config file, creating the parent directory if needed. */
export function writeCliConfig(config: CliConfig): void {
  const dir = dirname(options.MCP_CLI_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(options.MCP_CLI_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
