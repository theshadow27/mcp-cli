/**
 * MCP server configuration types.
 *
 * Matches the structure used by Claude Code in ~/.claude.json and .mcp.json.
 */

/** Base config shared by all transport types */
export interface BaseServerConfig {
  /** Optional: filter which tools are exposed */
  allowedTools?: string[];
  /** Optional: filter which tools are hidden (takes precedence over allowedTools) */
  disabledTools?: string[];
}

/** Stdio transport: spawn a local process */
export interface StdioServerConfig extends BaseServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** HTTP transport (Streamable HTTP, recommended for remote) */
export interface HttpServerConfig extends BaseServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** SSE transport (deprecated but still used by Atlassian) */
export interface SseServerConfig extends BaseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/** Union of all server config types */
export type ServerConfig = StdioServerConfig | HttpServerConfig | SseServerConfig;

/** Map of server name → config, as stored in config files */
export type ServerConfigMap = Record<string, ServerConfig>;

/** The mcpServers section of a config file */
export interface McpConfigFile {
  mcpServers?: ServerConfigMap;
}

/** Claude Code's ~/.claude.json structure (relevant parts) */
export interface ClaudeConfigFile {
  mcpServers?: ServerConfigMap;
  projects?: Record<
    string,
    {
      mcpServers?: ServerConfigMap;
      enabledMcpjsonServers?: string[];
      disabledMcpjsonServers?: string[];
      disabledMcpServers?: string[];
    }
  >;
}

/** Resolved server config with metadata about its source */
export interface ResolvedServer {
  name: string;
  config: ServerConfig;
  source: ConfigSource;
}

/** Where a config came from */
export interface ConfigSource {
  file: string;
  scope: "user" | "project" | "local" | "mcp-cli";
}

/** Full resolved configuration */
export interface ResolvedConfig {
  servers: Map<string, ResolvedServer>;
  sources: ConfigSource[];
}

// -- Type guards --

export function isStdioConfig(config: ServerConfig): config is StdioServerConfig {
  return "command" in config;
}

export function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
  return "url" in config && config.type === "http";
}

export function isSseConfig(config: ServerConfig): config is SseServerConfig {
  return "url" in config && (config.type === "sse" || (!("command" in config) && config.type !== "http"));
}

/** Get the transport type for a server config */
export function getTransportType(config: ServerConfig): "stdio" | "http" | "sse" {
  if (isStdioConfig(config)) return "stdio";
  if (isHttpConfig(config)) return "http";
  return "sse";
}
