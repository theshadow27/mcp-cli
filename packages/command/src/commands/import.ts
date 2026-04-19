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
import {
  CONFIG_SCOPES_NO_LOCAL,
  type ConfigScope,
  addServerToConfig,
  readConfigFile,
  resolveConfigPath,
} from "./config-file";

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

/** A single OAuth entry from the macOS Keychain */
export interface KeychainOAuthEntry {
  serverName: string;
  serverUrl: string;
  clientId: string;
}

/** Raw keychain data shape for mcpOAuth entries */
interface KeychainOAuthData {
  mcpOAuth?: Record<
    string,
    {
      serverName: string;
      serverUrl: string;
      clientId: string;
      accessToken: string;
    }
  >;
}

/**
 * Read all OAuth server entries from the Claude Code macOS Keychain.
 * Returns an empty array on non-macOS, missing keychain, or parse errors.
 *
 * @param readKeychain - optional override for testing (returns raw JSON string or null)
 */
export async function readKeychainOAuthEntries(
  readKeychain?: () => Promise<string | null>,
): Promise<KeychainOAuthEntry[]> {
  let raw: string | null;

  if (readKeychain) {
    raw = await readKeychain();
  } else {
    if (process.platform !== "darwin") return [];
    try {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      raw = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return [];
      raw = raw.trim();
    } catch {
      return [];
    }
  }

  if (!raw) return [];

  try {
    const data: KeychainOAuthData = JSON.parse(raw);
    const mcpOAuth = data.mcpOAuth;
    if (!mcpOAuth) return [];

    const entries: KeychainOAuthEntry[] = [];
    for (const entry of Object.values(mcpOAuth)) {
      if (entry.serverUrl && entry.clientId && entry.serverName) {
        entries.push({
          serverName: entry.serverName,
          serverUrl: entry.serverUrl,
          clientId: entry.clientId,
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Determine transport type from a URL.
 * URLs ending with /sse get SSE transport; everything else gets HTTP.
 */
export function inferTransportType(url: string): "http" | "sse" {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/sse") ? "sse" : "http";
  } catch {
    return "http";
  }
}

/**
 * Build a ServerConfig from a keychain OAuth entry.
 */
export function keychainEntryToServerConfig(entry: KeychainOAuthEntry): ServerConfig {
  const transport = inferTransportType(entry.serverUrl);
  return {
    type: transport,
    url: entry.serverUrl,
  };
}

/**
 * Import OAuth servers discovered in the macOS Keychain.
 * Checks existing config and only adds servers that aren't already present (by URL match).
 */
export async function importFromKeychain(
  scope: ConfigScope,
  readKeychain?: () => Promise<string | null>,
): Promise<void> {
  const entries = await readKeychainOAuthEntries(readKeychain);
  if (entries.length === 0) {
    console.error("No OAuth servers found in Claude Code keychain.");
    return;
  }

  // Load existing config to check for already-configured servers
  const configPath = resolveConfigPath(scope);
  const existing = readConfigFile(configPath);
  const existingServers = existing.mcpServers ?? {};

  // Check each entry's URL against all existing server URLs
  const existingUrls = new Set<string>();
  for (const cfg of Object.values(existingServers)) {
    if ("url" in cfg) {
      existingUrls.add(cfg.url);
    }
  }

  console.error(`Found ${entries.length} OAuth server(s) in Claude Code keychain:`);

  let imported = 0;
  for (const entry of entries) {
    const shortClientId = entry.clientId.length > 6 ? `${entry.clientId.slice(0, 6)}...` : entry.clientId;

    if (existingUrls.has(entry.serverUrl)) {
      console.error(
        `  ${entry.serverName.padEnd(12)} ${entry.serverUrl.padEnd(40)} (client: ${shortClientId})  ✓ already configured`,
      );
      continue;
    }

    const serverConfig = keychainEntryToServerConfig(entry);
    addServerToConfig(scope, entry.serverName, serverConfig);
    imported++;
    console.error(`  ${entry.serverName.padEnd(12)} ${entry.serverUrl.padEnd(40)} (client: ${shortClientId})  → added`);
  }

  if (imported > 0) {
    console.error(`\nImported ${imported} server(s).`);
  } else {
    console.error("\nAll servers already configured.");
  }
}

function loadMcpConfigFile(filePath: string): McpConfigFile {
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
  return config;
}

function importFromMcpFile(filePath: string, scope: ConfigScope): void {
  const config = loadMcpConfigFile(filePath);
  const servers = config.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    console.error(`No servers found in ${filePath}`);
    return;
  }
  importServers(servers, scope, filePath);
}

export interface CmdImportOptions {
  cwd?: string;
  findFile?: (filename: string, startDir: string) => string | null;
}

export async function cmdImport(args: string[], opts?: string | CmdImportOptions): Promise<void> {
  const normalizedOpts: CmdImportOptions = typeof opts === "string" ? { cwd: opts } : (opts ?? {});
  const cwd = normalizedOpts.cwd ?? process.cwd();
  const findFile = normalizedOpts.findFile ?? findFileUpward;
  // Parse flags
  let scope: ConfigScope | undefined;
  let claude = false;
  let all = false;
  let fromKeychain = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" || arg === "-s") {
      scope = parseScope(args[++i], CONFIG_SCOPES_NO_LOCAL);
    } else if (arg === "--claude" || arg === "-c") {
      claude = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--from-keychain") {
      fromKeychain = true;
    } else if (arg === "--help" || arg === "-h") {
      printImportUsage();
      return;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (fromKeychain) {
    await importFromKeychain(scope ?? "user");
    return;
  }

  if (claude) {
    await importFromClaude(scope ?? "user", all, undefined, cwd);
    return;
  }

  const source = positional[0];

  // No explicit source: walk up for .mcp.json, then fall through to ~/.claude.json
  if (!source) {
    const found = findFile(PROJECT_MCP_FILENAME, cwd);
    if (!found) {
      console.error(`No ${PROJECT_MCP_FILENAME} found. Falling back to ~/.claude.json…`);
      await importFromClaude(scope ?? "user", all, undefined, cwd);
      return;
    }
    importFromMcpFile(found, scope ?? "user");
    return;
  }

  const { filePath, defaultScope } = resolveSource(source);
  const effectiveScope = scope ?? defaultScope;
  importFromMcpFile(filePath, effectiveScope);
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
  cwd = process.cwd(),
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

function resolveSource(source: string): ResolvedSource {
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

/**
 * `mcx add-from-claude-desktop` — import servers from Claude Desktop's config.
 *
 * Reads ~/Library/Application Support/Claude/claude_desktop_config.json,
 * lists discovered servers, and imports them into mcp-cli.
 */
export async function cmdAddFromClaudeDesktop(
  args: string[],
  configPath = options.CLAUDE_DESKTOP_CONFIG_PATH,
): Promise<void> {
  let scope: ConfigScope = "user";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" || arg === "-s") {
      scope = parseScope(args[++i], CONFIG_SCOPES_NO_LOCAL);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`mcx add-from-claude-desktop — import servers from Claude Desktop

Usage:
  mcx add-from-claude-desktop              Import all servers from Claude Desktop config
  mcx add-from-claude-desktop --scope user Override target scope (default: user)

Options:
  --scope user|project    Target config scope (default: user)
  -s                      Shorthand for --scope

Reads: ~/Library/Application Support/Claude/claude_desktop_config.json`);
      return;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!existsSync(configPath)) {
    throw new Error(`Claude Desktop config not found: ${configPath}`);
  }

  let config: McpConfigFile;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as McpConfigFile;
  } catch {
    throw new Error(`Cannot parse ${configPath}`);
  }

  const servers = config.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    console.error(`No servers found in ${configPath}`);
    return;
  }

  importServers(servers, scope, "Claude Desktop");
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
  mcx import --from-keychain          Discover OAuth servers from Claude Code's macOS Keychain

Options:
  --claude, -c                        Read servers from Claude Code's ~/.claude.json
  --all                               With --claude: import from all projects, not just CWD
  --from-keychain                     Auto-discover OAuth servers from macOS Keychain
  --scope user|project                Override target scope (default varies by source)
  -s                                  Shorthand for --scope

Servers are copied into mcp-cli's own config. The daemon picks up changes automatically.`);
}
