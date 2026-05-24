/**
 * Shared spawn helper for terminal adapters.
 * Abstracts Bun.spawn for testability — adapters accept a SpawnFn via constructor DI.
 */

import { spawnCapture } from "@mcp-cli/core";

/** Spawn a command, throwing on non-zero exit. `label` is for error messages. */
export type SpawnFn = (args: string[], label: string) => Promise<void>;

/** Default implementation using spawnCapture */
export const defaultSpawn: SpawnFn = async (args, label) => {
  const result = await spawnCapture(args[0] ?? "", args.slice(1));
  if (!result.ok) {
    throw new Error(`${label}: command failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
};
