import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DAEMON_BINARY_NAME, DAEMON_DEV_SCRIPT, options } from "./constants";
import type { Logger } from "./logger";
import { consoleLogger } from "./logger";

/**
 * Check whether `resolvedPath` is equal to or nested under `resolvedRoot`.
 * Both arguments must already be fully resolved (symlinks followed).
 */
export function isPathContained(resolvedPath: string, resolvedRoot: string): boolean {
  if (resolvedRoot === "/") return false;
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

/**
 * Resolve symlinks in filePath. For non-existent paths, walks up the directory
 * chain until realpathSync succeeds, then re-joins the missing tail — same
 * iterative approach used in ContainmentGuard (#1481).
 */
export function resolveRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    const missingSegments: string[] = [];
    let current = resolve(filePath);
    while (true) {
      const parent = dirname(current);
      if (parent === current) return resolve(filePath);
      missingSegments.unshift(basename(current));
      try {
        return join(realpathSync(parent), ...missingSegments);
      } catch {
        current = parent;
      }
    }
  }
}

/** Ensure ~/.mcp-cli/ exists with owner-only permissions (0700) */
export function ensureStateDir(): void {
  mkdirSync(options.MCP_CLI_DIR, { recursive: true, mode: 0o700 });
}

/** Set a file to owner-only read/write (0600) */
export function hardenFile(filePath: string): void {
  chmodSync(filePath, 0o600);
}

/** Warn to stderr if runtime state permissions are too open (group/other bits set) */
export function auditRuntimePermissions(logger: Logger = consoleLogger): void {
  try {
    const dirMode = statSync(options.MCP_CLI_DIR).mode & 0o777;
    if (dirMode & 0o077) {
      logger.warn(
        `[security] Warning: ${options.MCP_CLI_DIR} has mode 0${dirMode.toString(8)}, expected 0700 — run: chmod 700 ${options.MCP_CLI_DIR}`,
      );
    }
  } catch {
    /* directory doesn't exist yet */
  }

  for (const filePath of [options.DB_PATH, options.SOCKET_PATH]) {
    try {
      const fileMode = statSync(filePath).mode & 0o777;
      if (fileMode & 0o077) {
        logger.warn(
          `[security] Warning: ${filePath} has mode 0${fileMode.toString(8)}, expected 0600 — run: chmod 600 ${filePath}`,
        );
      }
    } catch {
      /* file doesn't exist yet */
    }
  }
}

/**
 * Resolve the command to launch the daemon.
 *
 * 1. Compiled mode: look for `mcpd` binary next to the current executable.
 * 2. Dev mode: walk up from `startDir` to find the workspace root, then resolve the daemon script.
 * 3. Fallback: assume `mcpd` is on PATH.
 */
export function resolveDaemonCommand(startDir: string): string[] {
  const siblingBinary = join(dirname(process.execPath), DAEMON_BINARY_NAME);
  if (existsSync(siblingBinary)) return [siblingBinary];

  const devScript = findFileUpward(DAEMON_DEV_SCRIPT, startDir);
  if (devScript) return ["bun", "run", devScript];

  return [DAEMON_BINARY_NAME];
}

/**
 * Walk up from `startDir` looking for `filename`. Returns the full path or null.
 */
export function findFileUpward(filename: string, startDir: string): string | null {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
