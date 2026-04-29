/**
 * Safe file reading with size limits.
 *
 * Prevents hanging on device files (e.g. /dev/urandom) and guards against
 * accidentally loading huge files into memory.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Read a file with a size check.
 * Throws if the file exceeds MAX_FILE_SIZE or doesn't exist.
 */
export function readFileWithLimit(path: string): string {
  const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const file = Bun.file(resolved);
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File "${resolved}" is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds 10MB limit`);
  }
  return readFileSync(resolved, "utf-8");
}

/**
 * Resolve an `@path` reference: if `value` starts with `@`, read and return
 * the file contents; otherwise return `value` as-is.
 *
 * Delegates to `read` for testability — callers pass `readFileWithLimit`.
 */
export function resolveAtPath(value: string, read: (path: string) => string): string {
  if (!value.startsWith("@")) return value;
  return read(value.slice(1));
}
