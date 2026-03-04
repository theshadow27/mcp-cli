import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DB_PATH, MCP_CLI_DIR } from "./constants.js";

/** Ensure ~/.mcp-cli/ exists with owner-only permissions (0700) */
export function ensureStateDir(): void {
  mkdirSync(MCP_CLI_DIR, { recursive: true, mode: 0o700 });
}

/** Set a file to owner-only read/write (0600) */
export function hardenFile(filePath: string): void {
  chmodSync(filePath, 0o600);
}

/** Warn to stderr if runtime state permissions are too open (group/other bits set) */
export function auditRuntimePermissions(): void {
  try {
    const dirMode = statSync(MCP_CLI_DIR).mode & 0o777;
    if (dirMode & 0o077) {
      console.error(
        `[security] Warning: ${MCP_CLI_DIR} has mode 0${dirMode.toString(8)}, expected 0700 — run: chmod 700 ${MCP_CLI_DIR}`,
      );
    }
  } catch {
    /* directory doesn't exist yet */
  }

  try {
    const fileMode = statSync(DB_PATH).mode & 0o777;
    if (fileMode & 0o077) {
      console.error(
        `[security] Warning: ${DB_PATH} has mode 0${fileMode.toString(8)}, expected 0600 — run: chmod 600 ${DB_PATH}`,
      );
    }
  } catch {
    /* db doesn't exist yet */
  }
}

/**
 * Walk up from `startDir` looking for `filename`. Returns the full path or null.
 */
export function findFileUpward(filename: string, startDir: string): string | null {
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
