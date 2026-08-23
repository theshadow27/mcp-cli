/**
 * @rule spawn-managed-explicit-env
 * @expect 0
 * @path packages/command/src/daemon-lifecycle.ts
 *
 * Both calls pass an explicit `env` — the live process.env at spawn time
 * reaches the child correctly, unlike the implicit-inherit fallback.
 */

import { spawnManaged } from "@mcp-cli/core";

function startDaemon(bin: string, args: string[]): void {
  spawnManaged(bin, args, { env: process.env, stdout: "pipe", stderr: "pipe" });
}

function startAgent(bin: string, args: string[], extra: Record<string, string>): void {
  spawnManaged(bin, args, { env: { ...process.env, ...extra }, stdout: "pipe" });
}

void startDaemon;
void startAgent;
