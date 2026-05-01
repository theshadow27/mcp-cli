/**
 * Safe file reading with size limits and path containment.
 *
 * Prevents hanging on device files (e.g. /dev/urandom), guards against
 * accidentally loading huge files into memory, and blocks path traversal
 * outside the user's working directory (#1899).
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isPathContained, resolveRealpath } from "@mcp-cli/core";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function isPathAllowed(resolved: string): boolean {
  const cwd = resolveRealpath(process.cwd());
  return isPathContained(resolved, cwd);
}

/**
 * Read a file with a size check and path containment guard.
 * Throws if the path escapes cwd, exceeds MAX_FILE_SIZE, doesn't exist,
 * or appears to be binary.
 *
 * Accepted risk: TOCTOU window between resolveRealpath and readFileSync
 * allows a symlink target swap. Practical risk is low for direct CLI use;
 * a proper fix requires open(O_NOFOLLOW) + fstat which readFileSync
 * does not support. See #1899 review for discussion.
 */
export function readFileWithLimit(path: string): string {
  if (path.startsWith("~/")) {
    throw new Error("~/ paths are not supported by @file — use a path relative to cwd instead");
  }
  const absolute = resolve(path);
  const resolved = resolveRealpath(absolute);

  if (!isPathAllowed(resolved)) {
    throw new Error(`Path "${path}" resolves to "${resolved}" which is outside the allowed directory (cwd)`);
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path "${path}" is not a regular file`);
  }

  if (process.env.DEBUG) {
    process.stderr.write(`[@file] resolved: ${resolved}\n`);
  }

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
