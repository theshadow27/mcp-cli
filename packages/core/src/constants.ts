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

/**
 * Build version — VERSION with a build suffix.
 * Compiled binaries: injected at build time as "yyyyMMdd" → e.g. "0.1.0-20260308".
 * Dev mode (bun dev:mcx): falls back to "0.1.0-dev".
 */
declare const __BUILD_DATE__: string;
export const BUILD_VERSION: string = `${VERSION}-${typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "dev"}`;

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

/** Runtime state directory (override with MCP_CLI_DIR env var for test isolation) */
export const MCP_CLI_DIR = process.env.MCP_CLI_DIR || join(homedir(), ".mcp-cli");

/** SQLite database path */
const DB_PATH = join(MCP_CLI_DIR, "state.db");

/** CLI config file path (trust-claude, etc.) */
const MCP_CLI_CONFIG_PATH = join(MCP_CLI_DIR, "config.json");

/** Daemon Unix socket path */
const SOCKET_PATH = join(MCP_CLI_DIR, "mcpd.sock");

/** Daemon PID file path */
const PID_PATH = join(MCP_CLI_DIR, "mcpd.pid");

/** Alias scripts directory */
const ALIASES_DIR = join(MCP_CLI_DIR, "aliases");

/** Registry response cache directory */
const CACHE_DIR = join(MCP_CLI_DIR, "cache");

/**
 * Mutable options object for testability.
 * Tests can override individual values and call `_restoreOptions()` in afterAll.
 * Production code should read from `options.X` instead of the top-level constant.
 */
const _originalOptions = {
  MCP_CLI_DIR,
  DB_PATH,
  MCP_CLI_CONFIG_PATH,
  SOCKET_PATH,
  PID_PATH,
  ALIASES_DIR,
  CACHE_DIR,
  CLAUDE_CONFIG_PATH: join(homedir(), ".claude.json"),
  USER_SERVERS_PATH: join(MCP_CLI_DIR, "servers.json"),
  PROJECTS_DIR: join(MCP_CLI_DIR, "projects"),
  TYPES_PATH: join(MCP_CLI_DIR, "mcp-cli.d.ts"),
  LOCK_PATH: join(MCP_CLI_DIR, "mcpd.lock"),
  DAEMON_LOG_PATH: join(MCP_CLI_DIR, "mcpd.log"),
  DAEMON_LOG_BACKUP_PATH: join(MCP_CLI_DIR, "mcpd.log.1"),
  /** Directory for headless process logs (`mcx tty open --headless`) */
  LOGS_DIR: join(MCP_CLI_DIR, "logs"),
  /** Mail TTL (ms) — read messages older than this are pruned (default 7 days) */
  MAIL_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  /** How many log inserts between prune passes (amortized O(1)) */
  LOG_PRUNE_INTERVAL: 100,
  /** How many mail operations between TTL prune passes */
  MAIL_PRUNE_INTERVAL: 50,
  /** How many log writes between rotation size checks (amortized statSync) */
  LOG_ROTATION_CHECK_INTERVAL: 64,
  /** Max usage_stats rows before pruning oldest entries */
  USAGE_STATS_MAX_ROWS: 10_000,
  /** How many usage inserts between prune passes (amortized O(1)) */
  USAGE_PRUNE_INTERVAL: 100,
  /** How many span inserts between prune passes */
  SPAN_PRUNE_INTERVAL: 100,
  /** Max span rows before pruning oldest entries (regardless of export status) */
  SPANS_MAX_ROWS: 50_000,
};
export const options = { ..._originalOptions };
export function _restoreOptions(): void {
  Object.assign(options, _originalOptions);
}

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
  return join(options.ALIASES_DIR, `${name}.ts`);
}

/** Project-level MCP config filename */
export const PROJECT_MCP_FILENAME = ".mcp.json";

/**
 * Return the project-scoped server config path for a given working directory.
 * Uses mangled absolute path as directory name (e.g. `/Users/j/code/app` → `Users_j_code_app`).
 */
export function projectConfigPath(cwd: string): string {
  const mangled = resolve(cwd).replaceAll("/", "_").replace(/^_/, "");
  return join(options.PROJECTS_DIR, mangled, "servers.json");
}

/** Default daemon idle timeout (ms) */
export const DAEMON_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** IPC connect timeout when auto-starting daemon (ms) */
export const DAEMON_START_TIMEOUT_MS = 5_000;

/** Cooldown after a failed daemon start attempt (ms) — prevents unbounded spawn loops */
export const DAEMON_START_COOLDOWN_MS = 10_000;

/** IPC request timeout (ms) — generous for slow stdio servers like npx mcp-remote */
export const IPC_REQUEST_TIMEOUT_MS = 60_000;

/** MCP SDK tool call timeout (ms) — overrides SDK's 60s default for long-running tools */
export const MCP_TOOL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Daemon health-check ping timeout (ms) — must tolerate brief event loop stalls */
export const PING_TIMEOUT_MS = 5_000;

/** Max PID file age before treating as stale (ms) — 7 days */
export const PID_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Connection retry defaults.
 *
 * Budget must fit inside IPC_REQUEST_TIMEOUT_MS (60s):
 *   worst case = (MAX_RETRIES + 1) × CONNECT_TIMEOUT + sum(backoff delays)
 *             = 3 × 15s + 1s + 2s = 48s < 60s
 */
export const CONNECT_MAX_RETRIES = 2;
export const CONNECT_INITIAL_DELAY_MS = 1_000;
export const CONNECT_MAX_DELAY_MS = 15_000;

/** MCP server connect timeout (ms) — how long to wait for client.connect() */
export const CONNECT_TIMEOUT_MS = 15_000;

/** Max daemon log file size before rotation (5 MB) */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Daemon ready signal (stdout) */
export const DAEMON_READY_SIGNAL = "MCPD_READY";

/** Compiled daemon binary name */
export const DAEMON_BINARY_NAME = "mcpd";

/** Daemon dev-mode script path (relative to workspace root) */
export const DAEMON_DEV_SCRIPT = "packages/daemon/src/index.ts";
