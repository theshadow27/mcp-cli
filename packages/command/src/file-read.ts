/**
 * Safe file reading with size limits and path containment.
 *
 * Prevents hanging on device files (e.g. /dev/urandom), guards against
 * accidentally loading huge files into memory, and blocks path traversal
 * outside the user's working directory or home directory (#1899).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRealpath } from "@mcp-cli/core";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const SENSITIVE_PATTERNS = [
  /(?:^|\/)\.ssh\//,
  /(?:^|\/)\.aws\//,
  /(?:^|\/)\.gnupg\//,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
];

/**
 * Check whether `resolved` falls inside one of the allowed prefixes
 * (cwd or home). Both the path and the prefixes are fully resolved
 * through symlinks before comparison.
 */
function isPathAllowed(resolved: string): boolean {
  const cwd = resolveRealpath(process.cwd());
  const home = resolveRealpath(homedir());
  for (const prefix of [cwd, home]) {
    if (resolved === prefix || resolved.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function isSensitivePath(resolved: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(resolved));
}

/**
 * Read a file with a size check and path containment guard.
 * Throws if the path escapes cwd/home, matches a sensitive pattern,
 * exceeds MAX_FILE_SIZE, doesn't exist, or appears to be binary.
 */
export function readFileWithLimit(path: string): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const absolute = resolve(expanded);
  const resolved = resolveRealpath(absolute);

  if (!isPathAllowed(resolved)) {
    throw new Error(`Path "${path}" resolves to "${resolved}" which is outside the allowed directories (cwd and home)`);
  }

  if (isSensitivePath(resolved)) {
    throw new Error(
      `Path "${path}" matches a sensitive pattern (.ssh, .aws, .gnupg, .env, .npmrc, .netrc) — reading blocked`,
    );
  }

  process.stderr.write(`[@file] resolved: ${resolved}\n`);

  const file = Bun.file(resolved);
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File "${resolved}" is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds 10MB limit`);
  }
  const content = readFileSync(resolved, "utf-8");
  if (content.slice(0, 8192).includes("\x00")) {
    throw new Error(`File "${resolved}" appears to be binary — only text files are supported`);
  }
  return content;
}

/**
 * Resolve an `@path` reference: if `value` starts with `@`, read and return
 * the file contents; otherwise return `value` as-is.
 *
 * `@@foo` escapes to the literal string `@foo`.
 * Delegates to `read` for testability — callers pass `readFileWithLimit`.
 */
export function resolveAtPath(value: string, read: (path: string) => string): string {
  if (value.startsWith("@@")) return value.slice(1);
  if (!value.startsWith("@")) return value;
  const path = value.slice(1);
  if (!path) throw new Error("'@' requires a path, e.g. @./spec.md");
  return read(path);
}
