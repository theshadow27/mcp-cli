/**
 * Config file resolution and merging.
 *
 * Reads MCP server configs from multiple sources (Claude Code, .mcp.json, ~/.mcp-cli)
 * and merges them with priority ordering.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ClaudeConfigFile,
  McpConfigFile,
  ResolvedConfig,
  ResolvedServer,
  ServerConfig,
  ServerConfigMap,
} from "@mcp-cli/core";
import { CLAUDE_CONFIG_PATH, PROJECT_MCP_FILENAME, USER_SERVERS_PATH } from "@mcp-cli/core";
import { expandEnvVarsDeep } from "@mcp-cli/core";

interface ConfigSource {
  file: string;
  scope: "user" | "project" | "local" | "mcp-cli";
}

/**
 * Load and merge all config sources for the given working directory.
 */
export async function loadConfig(cwd = process.cwd()): Promise<ResolvedConfig> {
  const servers = new Map<string, ResolvedServer>();
  const sources: ConfigSource[] = [];

  // Priority 4 (lowest): Claude Code user scope (top-level mcpServers in ~/.claude.json)
  const claudeConfig = await readClaudeConfig();
  if (claudeConfig?.mcpServers) {
    const source: ConfigSource = { file: CLAUDE_CONFIG_PATH, scope: "user" };
    sources.push(source);
    addServers(servers, claudeConfig.mcpServers, source);
  }

  // Priority 3: .mcp.json in CWD or ancestors (project team config)
  const mcpJsonPath = findFileUpward(PROJECT_MCP_FILENAME, cwd);
  if (mcpJsonPath) {
    const mcpConfig = await readJsonFile<McpConfigFile>(mcpJsonPath);
    if (mcpConfig?.mcpServers) {
      // Check if Claude Code has enabled/disabled any of these
      const projectPath = resolve(cwd);
      const projectSettings = claudeConfig?.projects?.[projectPath];
      const disabledMcpJson = projectSettings?.disabledMcpjsonServers ?? [];
      const enabledMcpJson = projectSettings?.enabledMcpjsonServers;
      const source: ConfigSource = { file: mcpJsonPath, scope: "project" };
      sources.push(source);
      for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
        if (disabledMcpJson.includes(name)) continue;
        if (enabledMcpJson && !enabledMcpJson.includes(name)) continue;
        addServer(servers, name, config, source);
      }
    }
  }

  // Priority 2: Claude Code local scope (project-specific in ~/.claude.json)
  if (claudeConfig?.projects) {
    const projectPath = findMatchingProject(Object.keys(claudeConfig.projects), cwd);
    if (projectPath) {
      const projectConfig = claudeConfig.projects[projectPath];
      if (projectConfig?.mcpServers) {
        const disabled = projectConfig.disabledMcpServers ?? [];
        const source: ConfigSource = { file: CLAUDE_CONFIG_PATH, scope: "local" };
        sources.push(source);
        for (const [name, config] of Object.entries(projectConfig.mcpServers)) {
          if (!disabled.includes(name)) {
            addServer(servers, name, config, source);
          }
        }
      }
    }
  }

  // Priority 1 (highest): ~/.mcp-cli/servers.json (explicit mcp-cli config)
  if (existsSync(USER_SERVERS_PATH)) {
    const userConfig = await readJsonFile<McpConfigFile>(USER_SERVERS_PATH);
    if (userConfig?.mcpServers) {
      const source: ConfigSource = { file: USER_SERVERS_PATH, scope: "mcp-cli" };
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

async function readClaudeConfig(): Promise<ClaudeConfigFile | null> {
  return readJsonFile<ClaudeConfigFile>(CLAUDE_CONFIG_PATH);
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
 * Walk up from `startDir` looking for `filename`. Returns the full path or null.
 */
function findFileUpward(filename: string, startDir: string): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : "/";

  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

/**
 * Find the best matching project path from Claude Code config.
 * Matches the CWD exactly or finds the longest prefix match.
 */
function findMatchingProject(projectPaths: string[], cwd: string): string | null {
  const resolved = resolve(cwd);

  // Exact match first
  if (projectPaths.includes(resolved)) return resolved;

  // Longest prefix match
  let best: string | null = null;
  let bestLen = 0;
  for (const p of projectPaths) {
    if ((resolved.startsWith(`${p}/`) || resolved === p) && p.length > bestLen) {
      best = p;
      bestLen = p.length;
    }
  }
  return best;
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
