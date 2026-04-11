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
  /** Optional: OAuth client ID for pre-configured credentials */
  clientId?: string;
  /** Optional: OAuth client secret for pre-configured credentials */
  clientSecret?: string;
  /** Optional: fixed port for OAuth callback server (default: random) */
  callbackPort?: number;
  /** Optional: OAuth scope to request (e.g. "openid email profile" for OIDC providers) */
  scope?: string;
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

/** Configuration for ephemeral (auto-saved) aliases */
export interface EphemeralAliasConfig {
  /** Enable auto-saving long CLI calls as ephemeral aliases (default: true) */
  enabled?: boolean;
  /** Minimum serialized args length (chars) to trigger auto-save (default: 400) */
  charThreshold?: number;
  /** Default TTL in milliseconds (default: 48h = 172800000) */
  ttlMs?: number;
  /** Run count threshold to trigger promotion hint (default: 3) */
  promotionThreshold?: number;
}

/** mcp-cli config file (~/.mcp-cli/config.json) */
export interface CliConfig {
  trustClaude?: boolean;
  /** Preferred terminal emulator for `mcx tty open` (e.g. ghostty, iterm, tmux) */
  terminal?: string;
  /** Fixed WebSocket port for Claude SDK sessions (default: 19275). Set 0 for random. */
  wsPort?: number;
  /** Configuration for ephemeral (auto-saved) aliases */
  ephemeralAliases?: EphemeralAliasConfig;
  /** Directories where the first-run import prompt has already been shown */
  promptedDirs?: string[];
  /** Whether anonymous usage telemetry is enabled (default: true). Set false to opt out. */
  telemetry?: boolean;
}

/** Claude Code project settings (.claude/settings.local.json) */
export interface ClaudeProjectSettings {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
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
  return "url" in config && config.type === "sse";
}

/** Get the transport type for a server config */
export function getTransportType(config: ServerConfig): "stdio" | "http" | "sse" {
  if (isStdioConfig(config)) return "stdio";
  if (isHttpConfig(config)) return "http";
  if (isSseConfig(config)) return "sse";
  throw new Error('Unknown server config type: missing or invalid "type" field');
}
