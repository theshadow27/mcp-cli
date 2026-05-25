/**
 * Rule: args-bounds
 *
 * Flag `args[++i]` accesses without a prior bounds check. Hand-rolled
 * argument parsers that do `args[++i]` without first verifying `i + 1`
 * is in range silently produce `undefined` when `i` is already at the
 * last position — missing required flags go undetected.
 *
 * A line is considered SAFE if ANY of the following hold:
 *   1. Null coalescing immediately after args[++i]:  `args[++i] ??`
 *   2. Truthy pre-check: current or any of the preceding 6 lines uses
 *      `args[i + 1]` in a boolean context (`&& args[i + 1]`,
 *      `if (args[i + 1]`, etc.), or `args[i + 1]` is the first token
 *      followed by `&&`/`||` (multi-line `if` blocks).
 *   3. Explicit bounds comparison on the current or preceding 6 lines.
 *      Two regexes recognise the safe forms:
 *        - `BOUNDS_EXPR`: `i + 1 [<|<=|>|>=] args.length` (and the reversed
 *          forms with `args.length` on the left). Any comparator that
 *          pairs `i + 1` with `args.length` is accepted — the `i + 1`
 *          token already encodes the off-by-one for `args[++i]`.
 *        - `BOUNDS_EXPR_ALT`: `i < args.length - 1` / `args.length - 1 > i`
 *          (algebraic equivalent without the `i + 1` token). Strict `<`
 *          only — `i <= args.length - 1` is NOT safe (≡ `i < args.length`),
 *          since `args[++i]` accesses index `i + 1` which may equal
 *          `args.length`.
 *      Inline comments are stripped first so `// i + 1 < args.length`
 *      is not treated as a guard.
 *   4. Post-check on the assigned variable: the line assigns to a
 *      variable, and one of the next 2 lines checks it via `!varName`,
 *      `varName === undefined`, `varName === null`, or `varName == null`.
 *
 * Suppression: `// dotw-ignore args-bounds: <reason>` (handled by the
 * engine boundary).
 *
 * Migrated from the standalone `scripts/check-args-bounds.ts` — same
 * detection semantics, same lookback/lookahead windows.
 */

import type { CheckRule } from "./_engine/rule";

const ACCESS_PATTERN = /args\[\+\+i\]/;
const ASSIGN_PATTERN = /\b(\w+)\s*=\s*args\[\+\+i\]/;
const BOUNDS_EXPR = /\bi\s*\+\s*1\s*[<>]=?\s*args\.length\b|\bargs\.length\s*[<>]=?\s*\bi\s*\+\s*1\b/;
const BOUNDS_EXPR_ALT = /\bi\b\s*<\s*args\.length\s*-\s*1\b|\bargs\.length\s*-\s*1\s*>\s*\bi\b/;
const TRUTHY_PRE_CHECK = /(?:&&|\|\||if\s*\(|while\s*\()[^)]*args\[i\s*\+\s*1\]|^\s*args\[i\s*\+\s*1\]\s*(?:&&|\|\|)/;

export function isSafe(lines: string[], lineIdx: number): boolean {
  const line = lines[lineIdx];
  if (line === undefined) return true;

  if (/args\[\+\+i\]\s*\?\?/.test(line)) return true;

  const lookbackR2 = Math.max(0, lineIdx - 6);
  for (let j = lookbackR2; j <= lineIdx; j++) {
    if (TRUTHY_PRE_CHECK.test(lines[j] ?? "")) return true;
  }

  const lookback = Math.max(0, lineIdx - 6);
  for (let j = lookback; j <= lineIdx; j++) {
    const stripped = (lines[j] ?? "").replace(/\/\/.*$/, "");
    if (BOUNDS_EXPR.test(stripped) || BOUNDS_EXPR_ALT.test(stripped)) return true;
  }

  const assignMatch = ASSIGN_PATTERN.exec(line);
  if (assignMatch) {
    const varName = assignMatch[1];
    const lookahead = Math.min(lines.length - 1, lineIdx + 2);
    for (let j = lineIdx + 1; j <= lookahead; j++) {
      const next = lines[j] ?? "";
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

const rule: CheckRule = {
  id: "args-bounds",
  kind: "check",
  scold: "args[++i] without bounds check — silently produces undefined when i is at the last position",
  guidance: [
    "Bad:   val = args[++i];",
    "Good:  if (i + 1 < args.length) val = args[++i];",
    "Good:  val = args[++i] ?? defaultValue;",
    "Good:  const val = args[++i]; if (!val) { /* error */ }",
    "prefer parseFlags(argv, specs) from packages/command/src/flags.ts — it handles bounds, --flag=value, and unknown-flag detection",
    "permanent escape hatch: // dotw-ignore args-bounds: <reason> (non-empty reason required)",
  ],
  documentation: "#1967, #1968, #1969",
  check({ file, violated }) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!ACCESS_PATTERN.test(line)) continue;
      if (!isSafe(lines, i)) {
        violated(i + 1, 1, line.trim());
      }
    }
  },
};

export default rule;
