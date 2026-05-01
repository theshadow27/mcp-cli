#!/usr/bin/env bun
/**
 * Lint rule: flag args[++i] accesses without proper bounds checking.
 *
 * Hand-rolled argument parsers that do `args[++i]` without a prior bounds
 * check silently produce `undefined` when `i` is already at the last position.
 * This causes subtle bugs where missing required flags go undetected.
 *
 * A line is considered SAFE if ANY of the following hold:
 *   1. Null coalescing immediately after args[++i]:  args[++i] ??
 *   2. Truthy pre-check: current or preceding line contains args[i + 1]
 *   3. Explicit bounds check in the preceding 6 lines: both `i + 1` and
 *      `args.length` appear on the same line
 *   4. Post-check on the assigned variable: the line assigns args[++i] to a
 *      variable, and one of the next 2 lines checks that variable with
 *      `!varName`, `varName === undefined`, `varName === null`, or
 *      `varName == null`
 *
 * Usage:  bun scripts/check-args-bounds.ts
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — violations found
 */

import { Glob } from "bun";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;
const SCRIPTS_DIR = new URL("../scripts/", import.meta.url).pathname;
const TEST_DIR = new URL("../test/", import.meta.url).pathname;

/** Matches any args[++i] access. */
const ACCESS_PATTERN = /args\[\+\+i\]/;

/** Matches a variable assignment from args[++i], e.g. `const val = args[++i]` or `foo = args[++i]`. */
const ASSIGN_PATTERN = /\b(\w+)\s*=\s*args\[\+\+i\]/;

/** Matches an explicit `i + 1` token (with optional whitespace). */
const I_PLUS_1 = /\bi\s*\+\s*1\b/;

export interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Returns true if the args[++i] access on line `lineIdx` is safe.
 *
 * @param lines   Full array of lines from the file.
 * @param lineIdx Zero-based index of the line containing args[++i].
 */
export function isSafe(lines: string[], lineIdx: number): boolean {
  const line = lines[lineIdx];

  // Rule 1: null coalescing immediately after args[++i] — not anywhere on the line,
  // which would match `??` in comments or on unrelated sub-expressions.
  if (/args\[\+\+i\]\s*\?\?/.test(line)) return true;

  // Rule 2: truthy pre-check — current or preceding line uses args[i + 1] as a guard
  // Must appear in a boolean context: `&& args[i + 1]`, `|| args[i + 1]`,
  // `if (args[i + 1]`, or `while (... args[i + 1]` — not a bare read like `const x = args[i + 1]`.
  const TRUTHY_PRE_CHECK = /(?:&&|\|\||if\s*\(|while\s*\()[^)]*args\[i\s*\+\s*1\]/;
  if (TRUTHY_PRE_CHECK.test(line)) return true;
  if (lineIdx > 0 && TRUTHY_PRE_CHECK.test(lines[lineIdx - 1])) return true;

  // Rule 3: explicit bounds check in the preceding 6 lines *or on the current line*
  // (includes same-line ternary: `val = i + 1 < args.length ? args[++i] : null`)
  const lookback = Math.max(0, lineIdx - 6);
  for (let j = lookback; j <= lineIdx; j++) {
    if (I_PLUS_1.test(lines[j]) && lines[j].includes("args.length")) return true;
  }

  // Rule 4: post-check on assigned variable
  const assignMatch = ASSIGN_PATTERN.exec(line);
  if (assignMatch) {
    const varName = assignMatch[1];
    const lookahead = Math.min(lines.length - 1, lineIdx + 2);
    for (let j = lineIdx + 1; j <= lookahead; j++) {
      const next = lines[j];
      if (
        new RegExp(`!\\b${varName}\\b`).test(next) ||
        new RegExp(`\\b${varName}\\b\\s*===?\\s*(undefined|null)\\b`).test(next) ||
        new RegExp(`\\b(undefined|null)\\s*===?\\s*\\b${varName}\\b`).test(next)
      ) {
        return true;
      }
    }
  }

  return false;
}

async function scanDir(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");

  for await (const relPath of glob.scan({ cwd: dir, absolute: false })) {
    // Skip declaration files, node_modules, and this script + its tests
    if (relPath.endsWith(".d.ts") || relPath.includes("node_modules")) continue;
    if (relPath === "check-args-bounds.ts" || relPath === "check-args-bounds.spec.ts") continue;

    const absPath = `${dir}${relPath}`;
    const file = Bun.file(absPath);
    const content = await file.text();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (!ACCESS_PATTERN.test(lines[i])) continue;
      if (!isSafe(lines, i)) {
        violations.push({
          file: absPath,
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const dirs = [PACKAGES_DIR, SCRIPTS_DIR, TEST_DIR];
  const allViolations: Violation[] = [];

  for (const dir of dirs) {
    const violations = await scanDir(dir);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    process.stderr.write("No args bounds violations found.\n");
    process.exit(0);
  }

  process.stderr.write(`\n  Args bounds risk: ${allViolations.length} violation(s) found\n\n`);
  process.stderr.write("  args[++i] without a prior bounds check silently produces undefined.\n");
  process.stderr.write("  Add a bounds check before accessing the next argument.\n\n");

  for (const v of allViolations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n\n`);
  }

  process.stderr.write("  Bad:   val = args[++i];\n");
  process.stderr.write("  Good:  if (i + 1 < args.length) val = args[++i];\n");
  process.stderr.write("  Good:  val = args[++i] ?? defaultValue;\n\n");

  process.exit(1);
}

if (import.meta.main) main();
