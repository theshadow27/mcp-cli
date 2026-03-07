/**
 * Shared spawn helper for terminal adapters.
 * Abstracts Bun.spawn for testability — adapters accept a SpawnFn via constructor DI.
 */

/** Spawn a command, throwing on non-zero exit. `label` is for error messages. */
export type SpawnFn = (args: string[], label: string) => Promise<void>;

/** Default implementation using Bun.spawn */
export const defaultSpawn: SpawnFn = async (args, label) => {
  const proc = Bun.spawn(args, {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${label}: command failed (exit ${exitCode}): ${stderr.trim()}`);
  }
};
