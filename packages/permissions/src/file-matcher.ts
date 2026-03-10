/**
 * File path matching for permission evaluation.
 *
 * Uses Bun's built-in Glob for matching file paths against patterns.
 */

import { normalize } from "node:path";

/**
 * Match a file path against a glob pattern (e.g., "src/**\/*.ts").
 * Uses Bun's native Glob implementation — no external dependencies.
 *
 * The file path is normalized before matching to prevent directory
 * traversal attacks (e.g., "src/../../etc/passwd" matching "src/**").
 */
export function matchFilePath(filePath: string, pattern: string): boolean {
  const normalized = normalize(filePath);
  const glob = new Bun.Glob(normalize(pattern));
  return glob.match(normalized);
}
