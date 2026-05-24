/**
 * @rule no-raw-spawn
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Uses spawnCapture — the safe subprocess wrapper — and accesses exitCode
 * without null-coercing it.
 */

import { spawnCapture, spawnCaptureSync } from "./subprocess";

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

  return sync.stdout.trim();
}
