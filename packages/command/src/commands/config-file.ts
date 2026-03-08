/**
 * Config file read/write helpers for `mcx add`, `mcx remove`.
 *
 * Writes to either ~/.mcp-cli/servers.json (user scope) or .mcp.json (project scope).
 * The daemon's ConfigWatcher picks up changes automatically — no IPC needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { options, projectConfigPath } from "@mcp-cli/core";

export type ConfigScope = "user" | "project" | "local";

/** All valid config scopes. */
export const CONFIG_SCOPES = ["user", "project", "local"] as const;

/** Config scopes excluding "local" (for import/export which don't support it). */
export const CONFIG_SCOPES_NO_LOCAL = ["user", "project"] as const;

/** Resolve config file path from scope. "local" is an alias for "user". */
export function resolveConfigPath(scope: ConfigScope): string {
  if (scope === "project") {
    return projectConfigPath(process.cwd());
  }
  // "user" and "local" both write to servers.json
  return options.USER_SERVERS_PATH;
}

/** Read existing config file or return empty structure. */
export function readConfigFile(path: string): McpConfigFile {
  if (!existsSync(path)) {
    return { mcpServers: {} };
  }
  const content = readFileSync(path, "utf-8");
  const parsed = JSON.parse(content) as McpConfigFile;
  if (!parsed.mcpServers) {
    parsed.mcpServers = {};
  }
  return parsed;
}

/** Write config file, creating parent directory if needed. */
export function writeConfigFile(path: string, config: McpConfigFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Add a server to a config file. Returns true if it replaced an existing entry. */
export function addServerToConfig(scope: ConfigScope, name: string, serverConfig: ServerConfig): boolean {
  const path = resolveConfigPath(scope);
  const config = readConfigFile(path);
  const existed = name in (config.mcpServers ?? {});
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[name] = serverConfig;
  writeConfigFile(path, config);
  return existed;
}

/** Remove a server from a config file. Returns true if the server was found. */
export function removeServerFromConfig(scope: ConfigScope, name: string): boolean {
  const path = resolveConfigPath(scope);
  const config = readConfigFile(path);
  if (!config.mcpServers || !(name in config.mcpServers)) {
    return false;
  }
  const { [name]: _, ...rest } = config.mcpServers;
  config.mcpServers = rest;
  writeConfigFile(path, config);
  return true;
}
