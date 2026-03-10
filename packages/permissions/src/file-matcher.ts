/**
 * File path matching for permission evaluation.
 *
 * Uses Bun's built-in Glob for matching file paths against patterns.
 */

/**
 * Match a file path against a glob pattern (e.g., "src/**\/*.ts").
 * Uses Bun's native Glob implementation — no external dependencies.
 */
export function matchFilePath(filePath: string, pattern: string): boolean {
  const glob = new Bun.Glob(pattern);
  return glob.match(filePath);
}
