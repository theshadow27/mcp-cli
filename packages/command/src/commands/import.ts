/**
 * `mcx import` — import servers from external config files into mcp-cli's own config.
 *
 * Source resolution:
 *   mcx import                  Walk up from CWD to find .mcp.json, import those servers
 *   mcx import <file>           Import from a specific JSON config file
 *   mcx import . | <dir>        Import from .mcp.json in the given directory (project scope)
 *   mcx import --claude         Import from ~/.claude.json (global + project-scoped for CWD)
 *   mcx import --claude --all   Import all servers from ~/.claude.json (all projects)
 *
 * Target:
 *   --scope user    → ~/.mcp-cli/servers.json (default for file / no-arg / --claude)
 *   --scope project → ~/.mcp-cli/projects/{mangled-cwd}/servers.json (default for . / dir)
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpConfigFile, ServerConfig, ServerConfigMap } from "@mcp-cli/core";
import { PROJECT_MCP_FILENAME, findFileUpward, options } from "@mcp-cli/core";
import { printError } from "../output";
import { parseScope } from "../parse";
import { CONFIG_SCOPES_NO_LOCAL, type ConfigScope, addServerToConfig, resolveConfigPath } from "./config-file";

/** Shape of ~/.claude.json relevant to server config */
export interface ClaudeConfig {
  mcpServers?: ServerConfigMap;
  projects?: Record<string, { mcpServers?: ServerConfigMap }>;
}

/** Result of collecting servers from Claude Code config */
export interface ClaudeCollectResult {
  servers: ServerConfigMap;
  sources: string[];
  warnings: string[];
}

/**
 * Extract MCP servers from a Claude Code config structure.
 * Pure function — no I/O, easy to test.
 */
export function collectClaudeServers(config: ClaudeConfig, cwd: string, all: boolean): ClaudeCollectResult {
  const servers: ServerConfigMap = {};
  const sources: string[] = [];
  const warnings: string[] = [];

  // Global mcpServers
  if (config.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      servers[name] = serverConfig;
    }
    if (Object.keys(config.mcpServers).length > 0) {
      sources.push("global");
    }
  }

  // Project-scoped mcpServers
  const projects = config.projects ?? {};
  const resolvedCwd = resolve(cwd);

  for (const [projectPath, projectConfig] of Object.entries(projects)) {
    if (!projectConfig?.mcpServers) continue;
    if (!all && !resolvedCwd.startsWith(resolve(projectPath))) continue;

    for (const [name, serverConfig] of Object.entries(projectConfig.mcpServers)) {
      if (name in servers) {
        warnings.push(`"${name}" from ${projectPath} overwrites earlier definition`);
      }
      servers[name] = serverConfig;
    }
    sources.push(projectPath);
  }

  return { servers, sources, warnings };
}

export async function cmdImport(args: string[]): Promise<void> {
  // Parse flags
  let scope: ConfigScope | undefined;
  let claude = false;
  let all = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" || arg === "-s") {
      scope = parseScope(args[++i], CONFIG_SCOPES_NO_LOCAL);
    } else if (arg === "--claude" || arg === "-c") {
      claude = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--help" || arg === "-h") {
      printImportUsage();
      return;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (claude) {
    await importFromClaude(scope ?? "user", all);
    return;
  }

  const source = positional[0];
  const { filePath, defaultScope } = resolveSource(source);
  const effectiveScope = scope ?? defaultScope;

  // Read and validate source file
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read ${filePath}`);
  }

  let config: McpConfigFile;
  try {
    config = JSON.parse(content) as McpConfigFile;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }

  const servers = config.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    console.error(`No servers found in ${filePath}`);
    return;
  }

  // Import each server
  importServers(servers, effectiveScope, filePath);
}

export function importServers(servers: ServerConfigMap, scope: ConfigScope, source: string): void {
  const names = Object.keys(servers);
  let overwritten = 0;
  for (const name of names) {
    const existed = addServerToConfig(scope, name, servers[name]);
    if (existed) overwritten++;
  }

  const targetPath = resolveConfigPath(scope);
  console.error(`Imported ${names.length} server(s) from ${source} → ${targetPath}`);
  for (const name of names) {
    console.error(`  ${name}`);
  }
  if (overwritten > 0) {
    console.error(`(${overwritten} existing server(s) overwritten)`);
  }
}

export async function importFromClaude(
  scope: ConfigScope,
  all: boolean,
  configPath = options.CLAUDE_CONFIG_PATH,
): Promise<void> {
  if (!existsSync(configPath)) {
    throw new Error(`Claude Code config not found: ${configPath}`);
  }

  let claudeConfig: ClaudeConfig;
  try {
    claudeConfig = JSON.parse(readFileSync(configPath, "utf-8")) as ClaudeConfig;
  } catch {
    throw new Error(`Cannot parse ${configPath}`);
  }

  const cwd = process.cwd();
  const { servers, sources, warnings } = collectClaudeServers(claudeConfig, cwd, all);

  for (const w of warnings) {
    console.error(`  warning: ${w}`);
  }

  if (Object.keys(servers).length === 0) {
    if (all) {
      console.error(`No servers found in ${configPath}`);
    } else {
      console.error(`No servers found in ${configPath} for ${resolve(cwd)}`);
      console.error("Hint: use --all to import from all projects");
    }
    return;
  }

  const label = sources.length === 1 ? `~/.claude.json (${sources[0]})` : `~/.claude.json (${sources.length} sources)`;
  importServers(servers, scope, label);
}

interface ResolvedSource {
  filePath: string;
  defaultScope: ConfigScope;
}

function resolveSource(source: string | undefined): ResolvedSource {
  // No arg: walk up to find .mcp.json
  if (!source) {
    const found = findFileUpward(PROJECT_MCP_FILENAME, process.cwd());
    if (!found) {
      throw new Error(`No ${PROJECT_MCP_FILENAME} found in ${process.cwd()} or any parent directory`);
    }
    return { filePath: found, defaultScope: "user" };
  }

  const resolved = resolve(source);

  // Directory: look for .mcp.json inside it
  if (existsSync(resolved) && lstatSync(resolved).isDirectory()) {
    const candidate = join(resolved, PROJECT_MCP_FILENAME);
    if (!existsSync(candidate)) {
      throw new Error(`No ${PROJECT_MCP_FILENAME} found in ${resolved}`);
    }
    return { filePath: candidate, defaultScope: "project" };
  }

  // File path
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return { filePath: resolved, defaultScope: "user" };
}

function printImportUsage(): void {
  console.log(`mcx import — import servers from external config files

Usage:
  mcx import                          Find .mcp.json by walking up, import servers
  mcx import <file>                   Import from a specific config file
  mcx import .                        Import from .mcp.json in CWD (project scope)
  mcx import <dir>                    Import from .mcp.json in directory (project scope)
  mcx import --claude                 Import from ~/.claude.json (global + matching projects)
  mcx import --claude --all           Import from ~/.claude.json (all projects)

Options:
  --claude, -c                        Read servers from Claude Code's ~/.claude.json
  --all                               With --claude: import from all projects, not just CWD
  --scope user|project                Override target scope (default varies by source)
  -s                                  Shorthand for --scope

Servers are copied into mcp-cli's own config. The daemon picks up changes automatically.`);
}
