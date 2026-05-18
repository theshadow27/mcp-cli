/**
 * @rule shell-injection
 * @expect 2
 * @path packages/command/src/example.ts
 *
 * Two execSync calls with `${}` interpolation should each be flagged.
 * Plain template literals with no interpolation must NOT be flagged.
 */

import { execSync } from "node:child_process";

declare const repo: string;
declare const msg: string;

export function bad(): void {
  execSync(`git -C ${repo} status`);
  execSync(`echo ${msg}`);
}

export function ok(): void {
  execSync(`git status`); // no interpolation — fine
}
