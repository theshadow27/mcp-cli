/**
 * @rule no-raw-spawn
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Uses spawnCapture — the safe subprocess wrapper — and accesses exitCode
 * without null-coercing it. Also demonstrates false-positive guards:
 * process.exitCode is unrelated to subprocess exit codes.
 */

import { spawnCapture, spawnCaptureSync } from "@mcp-cli/core";

async function run() {
  const result = await spawnCapture("git", ["status"]);
  if (!result.ok) {
    console.error(result.stderr);
  }

  if (result.exitCode !== 0) {
    process.exit(1);
  }

  const sync = spawnCaptureSync("git", ["rev-parse", "HEAD"]);
  if (sync.timedOut) {
    console.error("timed out");
  }

  const code = process.exitCode ?? 0;
  const fallback = process.exitCode || 0;

  return sync.stdout.trim();
}
