/**
 * @rule shell-injection
 * @expect 0
 * @path packages/command/src/example-suppressed.ts
 *
 * A dotw-ignore comment on the preceding line suppresses the violation.
 * Used in cases where the input is provably hardcoded — e.g. a test
 * fixture that doesn't touch user input.
 */

import { execSync } from "node:child_process";

const SAFE_PORT = 5432;

export function trusted(): void {
  // dotw-ignore shell-injection: SAFE_PORT is a numeric literal, no shell metachar risk
  execSync(`lsof -i:${SAFE_PORT}`);
}
