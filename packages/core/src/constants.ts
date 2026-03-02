import { homedir } from "node:os";
import { join } from "node:path";

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

/** Daemon ready signal (stdout) */
export const DAEMON_READY_SIGNAL = "MCPD_READY";
