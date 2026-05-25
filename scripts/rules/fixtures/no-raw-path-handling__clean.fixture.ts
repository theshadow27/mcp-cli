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

// Map lookup with canonicalCwd — correct, not flagged
cache.get(canonicalCwd());
cache.set(canonicalCwd(), value);

// Variable bound to canonicalCwd used in comparison — not flagged
const normalizedDir = canonicalCwd();
if (normalizedDir === storedRoot) doSomething();

// process.cwd() as fallback default (not a direct const binding) — not flagged
const effectiveCwd = (args.cwd as string) ?? process.cwd();

// const bound to process.cwd() but never compared — not flagged
const myDir = process.cwd();
console.log(myDir);

// Detection 3 FP guard: process.cwd() in VALUE position of .set must NOT flag.
// Only argument 0 (the key) is checked.
cache.set("some-key", process.cwd());
indexByName.set(name, process.cwd());

// Detection 4 FP guard: a parameter named `cwd` that shadows the outer
// `const cwd = canonicalCwd()` (line 21 above) must NOT be flagged when
// compared. Scope-aware lookup resolves to the parameter, not the outer
// binding, so the result of the resolution is "not bound to process.cwd()".
function compareCwd(cwd: string, other: string): boolean {
  return cwd === other;
}

// Detection 4 FP guard: a local `const dir` bound to something else, even
// when the SAME file also has `const dir = process.cwd()` in another scope,
// must resolve to the local in the inner scope.
function localShadow(other: string): boolean {
  const dir = canonicalCwd();
  return dir === other;
}

// Detection 4 FP guard: a `const x = process.cwd()` declared inside a nested
// `if`/`for` block must NOT leak out to outer-scope name lookups. A naive
// descendant walk of the outer block would find the inner const and falsely
// flag the outer `dir === other` (the outer `dir` doesn't actually refer to
// that inner binding by JS lexical scope rules).
function nestedBlockScopeLeak(other: string): boolean {
  if (other) {
    const dir = process.cwd();
    void dir;
  }
  // @ts-expect-error fixture is excluded from typecheck — `dir` is intentionally
  // a free identifier here to exercise scope-resolution correctness.
  return dir === other;
}
