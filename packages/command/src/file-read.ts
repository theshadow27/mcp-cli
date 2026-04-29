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
 * Throws if the file exceeds MAX_FILE_SIZE, doesn't exist, or appears to be binary.
 */
export function readFileWithLimit(path: string): string {
  const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
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
