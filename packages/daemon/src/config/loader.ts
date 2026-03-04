/**
 * Config file resolution and merging.
 *
 * Reads MCP server configs from multiple sources (Claude Code, .mcp.json, ~/.mcp-cli)
 * and merges them with priority ordering.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ClaudeConfigFile,
  ClaudeProjectSettings,
  McpConfigFile,
  ResolvedConfig,
  ResolvedServer,
  ServerConfig,
  ServerConfigMap,
} from "@mcp-cli/core";
import { CLAUDE_CONFIG_PATH, PROJECT_MCP_FILENAME, USER_SERVERS_PATH } from "@mcp-cli/core";
import { expandEnvVarsDeep, readCliConfig } from "@mcp-cli/core";

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
      const cliConfig = readCliConfig();
      let disabledMcpJson: string[] = [];
      let enabledMcpJson: string[] | undefined;

      if (cliConfig.trustClaude) {
        // trust-claude mode: use .claude/settings.local.json next to .mcp.json
        const settingsPath = join(dirname(mcpJsonPath), ".claude", "settings.local.json");
        const settings = readJsonFileSync<ClaudeProjectSettings>(settingsPath);
        if (!settings) {
          // Settings file missing → skip all .mcp.json servers (safe default)
          enabledMcpJson = [];
        } else {
          enabledMcpJson = settings.enabledMcpjsonServers;
          disabledMcpJson = settings.disabledMcpjsonServers ?? [];
        }
      } else {
        // Default: use ~/.claude.json project scopes for filtering
        const matchingPaths = claudeConfig?.projects
          ? findMatchingProjects(Object.keys(claudeConfig.projects), cwd).reverse()
          : [];
        const projectSettings = matchingPaths
          .map((p) => claudeConfig?.projects?.[p])
          .find((s) => s?.enabledMcpjsonServers || s?.disabledMcpjsonServers);
        disabledMcpJson = projectSettings?.disabledMcpjsonServers ?? [];
        enabledMcpJson = projectSettings?.enabledMcpjsonServers;
      }

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
  // Walk all matching ancestor project scopes, broadest first, so child scopes
  // inherit parent servers and can override or disable them.
  if (claudeConfig?.projects) {
    const matchingPaths = findMatchingProjects(Object.keys(claudeConfig.projects), cwd);
    for (const projectPath of matchingPaths) {
      const projectConfig = claudeConfig.projects[projectPath];
      if (projectConfig?.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
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

function readJsonFileSync<T>(path: string): T | null {
  try {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
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
 * Find all matching project paths from Claude Code config.
 * Returns paths sorted broadest-first (shortest path first) so that
 * child scopes inherit servers from parent scopes and can override them.
 *
 * E.g. for cwd=/a/b/c, returns ["/a", "/a/b", "/a/b/c"] if all exist.
 */
function findMatchingProjects(projectPaths: string[], cwd: string): string[] {
  const resolved = resolve(cwd);

  return projectPaths.filter((p) => resolved.startsWith(`${p}/`) || resolved === p).sort((a, b) => a.length - b.length);
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
