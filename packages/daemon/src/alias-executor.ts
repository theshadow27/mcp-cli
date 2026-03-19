/**
 * Alias executor subprocess script.
 *
 * Launched by Bun.spawn from the daemon's alias server to execute
 * alias scripts in an isolated subprocess. Reads bundled JS + input
 * from stdin as JSON, executes via executeAliasBundled(), writes result
 * to stdout as JSON.
 *
 * This provides fault isolation: sync infinite loops, prototype
 * pollution, or crashes kill this subprocess, not the daemon.
 */

import { readFile } from "node:fs/promises";
import { type AliasContext, executeAliasBundled, stubProxy, validateAliasBundled } from "@mcp-cli/core";

interface ExecutorInput {
  bundledJs: string;
  input: unknown;
  isDefineAlias: boolean;
  mode?: "execute" | "validate";
}

async function main(): Promise<void> {
  // Redirect console to stderr so alias scripts' console.log doesn't corrupt stdout JSON protocol
  const stderrWrite = (data: string) => process.stderr.write(`${data}\n`);
  console.log = stderrWrite;
  console.warn = stderrWrite;
  console.error = stderrWrite;
  console.info = stderrWrite;
  console.debug = stderrWrite;

  // Read input from stdin
  const stdinText = await Bun.stdin.text();
  const { bundledJs, input, isDefineAlias, mode } = JSON.parse(stdinText) as ExecutorInput;

  if (mode === "validate") {
    const validation = await validateAliasBundled(bundledJs);
    process.stdout.write(JSON.stringify({ result: validation }));
    return;
  }

  const ctx: AliasContext = {
    mcp: stubProxy,
    args:
      typeof input === "object" && input !== null
        ? Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    file: (path: string) => readFile(path, "utf-8"),
    json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
    cache: async (_key, producer) => producer(),
  };

  const result = await executeAliasBundled(bundledJs, input, ctx, isDefineAlias);
  process.stdout.write(JSON.stringify({ result: result ?? null }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
