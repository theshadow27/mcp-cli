/**
 * @rule shell-injection
 * @expect 0
 * @path packages/command/src/example-safe.ts
 *
 * spawnSync with an args array is the prescribed safe form. No violation.
 */

import { spawnSync } from "node:child_process";

declare const repo: string;
declare const msg: string;

export function safe(): void {
  spawnSync("git", ["-C", repo, "status"]);
  spawnSync("echo", [msg]);
}
