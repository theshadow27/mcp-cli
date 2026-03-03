import { homedir } from "node:os";
import { join } from "node:path";

/** CLI version — updated on release */
export const VERSION = "0.1.0";

/** Runtime state directory */
export const MCP_CLI_DIR = join(homedir(), ".mcp-cli");

/** SQLite database path */
export const DB_PATH = join(MCP_CLI_DIR, "state.db");

/** Daemon Unix socket path */
export const SOCKET_PATH = join(MCP_CLI_DIR, "mcpd.sock");

/** Daemon PID file path */
export const PID_PATH = join(MCP_CLI_DIR, "mcpd.pid");

/** Alias scripts directory */
export const ALIASES_DIR = join(MCP_CLI_DIR, "aliases");

/** Generated TypeScript declarations for alias scripts */
export const TYPES_PATH = join(MCP_CLI_DIR, "mcp-cli.d.ts");

/** User-level server config (standalone, outside Claude Code) */
export const USER_SERVERS_PATH = join(MCP_CLI_DIR, "servers.json");

/** Claude Code user config */
export const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

/** Project-level MCP config filename */
export const PROJECT_MCP_FILENAME = ".mcp.json";

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

/** Daemon ready signal (stdout) */
export const DAEMON_READY_SIGNAL = "MCPD_READY";
