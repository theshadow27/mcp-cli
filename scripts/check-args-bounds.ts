#!/usr/bin/env bun
/**
 * Lint rule: flag args[++i] accesses without proper bounds checking.
 *
 * Hand-rolled argument parsers that do `args[++i]` without a prior bounds
 * check silently produce `undefined` when `i` is already at the last position.
 * This causes subtle bugs where missing required flags go undetected.
 *
 * A line is considered SAFE if ANY of the following hold:
 *   0. Inline suppression: the line ends with `// lint-allow-args-bounds: <reason>`
 *      (non-empty reason required to prevent lazy suppression)
 *   1. Null coalescing immediately after args[++i]:  args[++i] ??
 *   2. Truthy pre-check: current or any of the preceding 6 lines contains args[i + 1]
 *      in a boolean context (`&& args[i + 1]`, `if (args[i + 1]`, etc.)
 *   3. Explicit bounds comparison on the current line or in the preceding 6 lines:
 *      `i + 1 <|<=|>|>= args.length`, `i <|<= args.length - 1`, or the reversed
 *      forms — inline comments stripped first so `// i + 1 < args.length` is not
 *      treated as a guard
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

/** Matches a real bounds comparison between `i + 1` and `args.length` in either order. */
const BOUNDS_EXPR = /\bi\s*\+\s*1\s*[<>]=?\s*args\.length\b|\bargs\.length\s*[<>]=?\s*\bi\s*\+\s*1\b/;

/**
 * Matches algebraically equivalent forms: `i < args.length - 1` or `args.length - 1 > i`.
 * These are not caught by BOUNDS_EXPR because they lack the `i + 1` token.
 */
const BOUNDS_EXPR_ALT = /\bi\b\s*[<>]=?\s*args\.length\s*-\s*1\b|\bargs\.length\s*-\s*1\s*[<>]=?\s*\bi\b/;

/** Inline suppression marker. Requires a non-empty reason after the colon. */
const LINT_ALLOW = /\/\/\s*lint-allow-args-bounds:\s*\S/;

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

  // Rule 0: inline suppression marker — requires a non-empty reason.
  if (LINT_ALLOW.test(line)) return true;

  // Rule 1: null coalescing immediately after args[++i] — not anywhere on the line,
  // which would match `??` in comments or on unrelated sub-expressions.
  if (/args\[\+\+i\]\s*\?\?/.test(line)) return true;

  // Rule 2: truthy pre-check — current or any of the preceding 6 lines uses args[i + 1]
  // as a guard in a boolean context. 6-line lookback handles multi-line `if` blocks where
  // the guard sits 2+ lines above the access.
  // Two forms: boolean-context marker before the access (`&& args[i+1]`, `if (... args[i+1]`),
  // or the access before a trailing operator (`args[i+1] &&`) used in multi-line if blocks.
  const TRUTHY_PRE_CHECK = /(?:&&|\|\||if\s*\(|while\s*\()[^)]*args\[i\s*\+\s*1\]|args\[i\s*\+\s*1\]\s*(?:&&|\|\|)/;
  const lookbackR2 = Math.max(0, lineIdx - 6);
  for (let j = lookbackR2; j <= lineIdx; j++) {
    if (TRUTHY_PRE_CHECK.test(lines[j])) return true;
  }

  // Rule 3: explicit bounds comparison on the current line or in the preceding 6 lines.
  // Strip inline comments before matching so `// i + 1 < args.length` is not a guard.
  // Recognizes both `i + 1 < args.length` and `i < args.length - 1` (and reversed forms).
  const lookback = Math.max(0, lineIdx - 6);
  for (let j = lookback; j <= lineIdx; j++) {
    const stripped = lines[j].replace(/\/\/.*$/, "");
    if (BOUNDS_EXPR.test(stripped) || BOUNDS_EXPR_ALT.test(stripped)) return true;
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
      if (LINT_ALLOW.test(lines[i])) {
        process.stderr.write(`  [suppressed] ${absPath}:${i + 1}  ${lines[i].trim()}\n`);
        continue;
      }
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
