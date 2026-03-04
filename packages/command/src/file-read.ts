/**
 * Safe file reading with size limits.
 *
 * Prevents hanging on device files (e.g. /dev/urandom) and guards against
 * accidentally loading huge files into memory.
 */

import { readFileSync } from "node:fs";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Read a file with a size check.
 * Throws if the file exceeds MAX_FILE_SIZE or doesn't exist.
 */
export function readFileWithLimit(path: string): string {
  const file = Bun.file(path);
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File "${path}" is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds 10MB limit`);
  }
  return readFileSync(path, "utf-8");
}
