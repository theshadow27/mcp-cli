import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** CLI version — updated on release */
export const VERSION = "0.1.0";

/**
 * IPC protocol version — content hash of ipc.ts.
 * Injected at build time via --define; computed at runtime in dev mode.
 * Changes whenever the IPC contract (methods, params, result types) changes.
 */
declare const __PROTOCOL_HASH__: string;
export const PROTOCOL_VERSION: string =
  typeof __PROTOCOL_HASH__ !== "undefined" ? __PROTOCOL_HASH__ : computeDevProtocolHash();

function computeDevProtocolHash(): string {
  try {
    const content = readFileSync(join(import.meta.dir, "ipc.ts"), "utf-8");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    return hasher.digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
}

/** Runtime state directory */
export const MCP_CLI_DIR = join(homedir(), ".mcp-cli");

/** SQLite database path */
export const DB_PATH = join(MCP_CLI_DIR, "state.db");

/** CLI config file path (trust-claude, etc.) */
export const MCP_CLI_CONFIG_PATH = join(MCP_CLI_DIR, "config.json");

/** Daemon Unix socket path */
export const SOCKET_PATH = join(MCP_CLI_DIR, "mcpd.sock");

/** Daemon PID file path */
export const PID_PATH = join(MCP_CLI_DIR, "mcpd.pid");

/** Alias scripts directory */
export const ALIASES_DIR = join(MCP_CLI_DIR, "aliases");

/** Registry response cache directory */
export const CACHE_DIR = join(MCP_CLI_DIR, "cache");

/** Registry cache TTL (ms) — 1 hour */
export const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;

/** Valid alias name pattern — alphanumeric, hyphens, underscores only */
const ALIAS_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an alias name is safe for use in file paths.
 * Throws if the name is empty, contains path traversal characters, or other unsafe chars.
 */
export function validateAliasName(name: string): void {
  if (!name || !ALIAS_NAME_RE.test(name)) {
    throw new Error(
      `Invalid alias name "${name}": must match ${ALIAS_NAME_RE} (letters, digits, hyphens, underscores)`,
    );
  }
}

/**
 * Resolve an alias file path and verify it's inside ALIASES_DIR.
 * Returns the resolved path or throws on path traversal.
 */
export function safeAliasPath(name: string): string {
  validateAliasName(name);
  const resolved = join(ALIASES_DIR, `${name}.ts`);
  // Defense-in-depth: verify resolved path is inside ALIASES_DIR
  if (!resolved.startsWith(`${ALIASES_DIR}/`)) {
    throw new Error(`Alias path "${resolved}" escapes aliases directory`);
  }
  return resolved;
}

/** Generated TypeScript declarations for alias scripts */
export const TYPES_PATH = join(MCP_CLI_DIR, "mcp-cli.d.ts");

/** User-level server config (standalone, outside Claude Code) */
export const USER_SERVERS_PATH = join(MCP_CLI_DIR, "servers.json");

/** Claude Code user config */
export const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

/** Project-level MCP config filename */
export const PROJECT_MCP_FILENAME = ".mcp.json";

/** Directory for project-scoped server configs */
export const PROJECTS_DIR = join(MCP_CLI_DIR, "projects");

/**
 * Return the project-scoped server config path for a given working directory.
 * Uses mangled absolute path as directory name (e.g. `/Users/j/code/app` → `Users_j_code_app`).
 */
export function projectConfigPath(cwd: string): string {
  const mangled = resolve(cwd).replaceAll("/", "_").replace(/^_/, "");
  return join(PROJECTS_DIR, mangled, "servers.json");
}

/** Default daemon idle timeout (ms) */
export const DAEMON_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** IPC connect timeout when auto-starting daemon (ms) */
export const DAEMON_START_TIMEOUT_MS = 5_000;

/** IPC request timeout (ms) — generous for slow stdio servers like npx mcp-remote */
export const IPC_REQUEST_TIMEOUT_MS = 60_000;

/** Daemon health-check ping timeout (ms) */
export const PING_TIMEOUT_MS = 2_000;

/** Max PID file age before treating as stale (ms) — 7 days */
export const PID_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Connection retry defaults */
export const CONNECT_MAX_RETRIES = 3;
export const CONNECT_INITIAL_DELAY_MS = 1_000;
export const CONNECT_MAX_DELAY_MS = 15_000;

/** MCP server connect timeout (ms) — how long to wait for client.connect() */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Daemon startup lock file path */
export const LOCK_PATH = join(MCP_CLI_DIR, "mcpd.lock");

/** Persistent daemon log file path */
export const DAEMON_LOG_PATH = join(MCP_CLI_DIR, "mcpd.log");

/** Rotated daemon log backup path */
export const DAEMON_LOG_BACKUP_PATH = join(MCP_CLI_DIR, "mcpd.log.1");

/** Max daemon log file size before rotation (5 MB) */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Daemon ready signal (stdout) */
export const DAEMON_READY_SIGNAL = "MCPD_READY";

/** Compiled daemon binary name */
export const DAEMON_BINARY_NAME = "mcpd";

/** Daemon dev-mode script path (relative to workspace root) */
export const DAEMON_DEV_SCRIPT = "packages/daemon/src/index.ts";
