/**
 * Config file resolution and merging.
 *
 * Reads MCP server configs from mcp-cli's own config files only:
 * - ~/.mcp-cli/projects/{mangled-cwd}/servers.json (project-scoped)
 * - ~/.mcp-cli/servers.json (global)
 *
 * External configs (.mcp.json, ~/.claude.json) are NOT auto-loaded.
 * Use `mcx import` to explicitly bring servers into mcp-cli's config.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  ConfigSource,
  McpConfigFile,
  ResolvedConfig,
  ResolvedServer,
  ServerConfig,
  ServerConfigMap,
} from "@mcp-cli/core";
import { expandEnvVarsDeep, options, projectConfigPath } from "@mcp-cli/core";

/**
 * Load and merge all config sources for the given working directory.
 *
 * Only reads mcp-cli's own config:
 *   1. ~/.mcp-cli/projects/{mangled-cwd}/servers.json (project-scoped, lower priority)
 *   2. ~/.mcp-cli/servers.json (global, highest priority)
 */
export async function loadConfig(cwd = process.cwd()): Promise<ResolvedConfig> {
  const servers = new Map<string, ResolvedServer>();
  const sources: ConfigSource[] = [];

  // Priority 2 (lower): project-scoped config
  const projectPath = projectConfigPath(cwd);
  if (existsSync(projectPath)) {
    const projectConfig = await readJsonFile<McpConfigFile>(projectPath);
    if (projectConfig?.mcpServers) {
      const source: ConfigSource = { file: projectPath, scope: "project" };
      sources.push(source);
      addServers(servers, projectConfig.mcpServers, source);
    }
  }

  // Priority 1 (highest): ~/.mcp-cli/servers.json (global)
  if (existsSync(options.USER_SERVERS_PATH)) {
    const userConfig = await readJsonFile<McpConfigFile>(options.USER_SERVERS_PATH);
    if (userConfig?.mcpServers) {
      const source: ConfigSource = { file: options.USER_SERVERS_PATH, scope: "mcp-cli" };
      sources.push(source);
      addServers(servers, userConfig.mcpServers, source);
    }
  }

  // Expand env vars in all resolved configs
  for (const [name, resolved] of servers) {
    try {
      servers.set(name, {
        ...resolved,
        config: expandEnvVarsDeep(resolved.config, process.env as Record<string, string | undefined>, false),
      });
    } catch (err) {
      console.error(`[config] Failed to expand env vars for server "${name}": ${err}`);
    }
  }

  return { servers, sources };
}

// -- Helpers --

function addServers(target: Map<string, ResolvedServer>, configs: ServerConfigMap, source: ConfigSource): void {
  for (const [name, config] of Object.entries(configs)) {
    addServer(target, name, config, source);
  }
}

function addServer(
  target: Map<string, ResolvedServer>,
  name: string,
  config: ServerConfig,
  source: ConfigSource,
): void {
  target.set(name, { name, config, source });
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[config] Failed to parse ${path}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Compute a hash of a config for staleness detection.
 */
export function configHash(config: ResolvedConfig): string {
  const sorted = [...config.servers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { config }]) => [name, config]);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(sorted));
  return hasher.digest("hex").slice(0, 16);
}
