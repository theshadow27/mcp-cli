/**
 * @rule spawn-managed-explicit-env
 * @expect 2
 * @path packages/command/src/daemon-lifecycle.ts
 *
 * Two violations:
 *   1. spawnManaged(bin, args, { stdout: "pipe", stderr: "pipe" }) — an
 *      options object literal present, but no `env` property. This is
 *      exactly the #3233 bug shape: startDaemon() omitted `env`, so the
 *      auto-started daemon subprocess silently missed a test's live
 *      MCP_CLI_DIR override and fell back to the real homedir().
 *   2. spawnManaged(bin, args) — no options argument at all, so `env`
 *      can't have been set either.
 */

import { spawnManaged } from "@mcp-cli/core";

function startDaemon(bin: string, args: string[]): void {
  spawnManaged(bin, args, { stdout: "pipe", stderr: "pipe" });
}

function startWorker(bin: string, args: string[]): void {
  spawnManaged(bin, args);
}

void startDaemon;
void startWorker;
