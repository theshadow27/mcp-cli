/**
 * @rule no-raw-path-handling
 * @expect 0
 * @path packages/daemon/src/example-clean.ts
 *
 * Correct patterns: path.isAbsolute, pathEq, canonicalCwd.
 * Also validates that process.cwd() nested inside helper calls
 * (not a direct === operand) does NOT trigger false positives.
 */

import { isAbsolute } from "node:path";
import { canonicalCwd, pathEq } from "@mcp-cli/core";

// isAbsolute — correct way to check
if (isAbsolute(somePath)) doSomething();

// pathEq — correct way to compare paths
if (pathEq(a, b)) doSomething();

// canonicalCwd — correct way to capture cwd
const cwd = canonicalCwd();

// startsWith with a non-"/" string — not flagged
if (name.startsWith("packages/")) doSomething();
if (name.startsWith("-")) doSomething();

// Template-literal arg to startsWith — not flagged
if (p.startsWith(`${root}/`)) doSomething();

// process.cwd() nested inside a helper call, not a direct === operand —
// must NOT be flagged (thread #3 false-positive shape)
if (pathEq(process.cwd(), root) === true) doSomething();
const same = canonicalCwd() === storedRoot;
