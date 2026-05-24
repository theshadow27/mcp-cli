/**
 * Rule: poll-until-headroom
 *
 * `pollUntil` defaults to a 5000ms timeout — exactly Bun's per-test watchdog.
 * Under CI resource pressure, the watchdog fires before `pollUntil`'s own
 * descriptive error, producing a flake with a useless message.
 *
 * Flag:
 *   (a) `pollUntil(fn)` — no explicit timeout, relying on the 5000ms default
 *   (b) `pollUntil(fn, N)` where N ≥ 5000 — at or above the watchdog limit
 *
 * A condition should resolve in milliseconds, not seconds. Give the poll a
 * short deadline (hundreds of ms to ~1s), never one that flirts with the
 * test timeout.
 */

import type { CheckRule } from "./_engine/rule";

const BUN_DEFAULT_TIMEOUT = 5000;

/**
 * Starting from the `(` at `lines[startLine][parenOffset]`, collect the
 * balanced call text including the outer parens. Returns null if unbalanced.
 */
function collectCall(lines: string[], startLine: number, parenOffset: number): string | null {
  let text = "";
  let depth = 0;

  for (let j = startLine; j < Math.min(startLine + 30, lines.length); j++) {
    const segment = j === startLine ? lines[j].slice(parenOffset) : lines[j];
    for (let c = 0; c < segment.length; c++) {
      const ch = segment[c];
      text += ch;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return text;
      }
    }
    text += "\n";
  }
  return null;
}

/**
 * Find the index of the first comma at depth 0 (top-level) within `s`,
 * correctly skipping over nested parens, brackets, braces, and string literals.
 * Returns -1 if none found.
 */
function firstTopLevelComma(s: string): number {
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr !== null) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse a TypeScript numeric literal (with optional `_` separators) to a
 * JS number. Returns null if `s` is not a plain numeric literal.
 */
function parseNumericLiteral(s: string): number | null {
  const cleaned = s.trim().replace(/_/g, "");
  if (cleaned.length === 0) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && /^[0-9.e+\-]+$/i.test(cleaned) ? n : null;
}

const rule: CheckRule = {
  id: "poll-until-headroom",
  kind: "check",
  scold:
    "pollUntil() called with no explicit timeout or a timeout ≥ Bun's 5000ms test watchdog — flaky under CI pressure",
  guidance: [
    "pass a short explicit deadline: pollUntil(fn, 4000) — leave headroom so pollUntil's own error surfaces",
    "a condition should resolve in milliseconds, not seconds; if you need 4+ seconds the test waits on time, not a condition",
    'quote from Bun\'s own test discipline: "You are not testing the TIME PASSING, you are testing the CONDITION"',
    "cross-reference test/CLAUDE.md flaky-prevention patterns",
  ],
  documentation: "#2248",
  check({ file, violated }) {
    if (!file.isTest) return;

    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pollIdx = line.indexOf("pollUntil(");
      if (pollIdx === -1) continue;

      // parenOffset points to the '(' of the call
      const parenOffset = pollIdx + "pollUntil".length;
      const callText = collectCall(lines, i, parenOffset);
      if (!callText) continue;

      // inner = everything between the outer parens
      const inner = callText.slice(1, -1);
      const commaIdx = firstTopLevelComma(inner);

      if (commaIdx === -1) {
        // No second argument — relying on default 5000ms
        violated(i + 1, pollIdx + 1, line.trim());
      } else {
        const secondArg = inner.slice(commaIdx + 1).trim();
        const num = parseNumericLiteral(secondArg);
        if (num !== null && num >= BUN_DEFAULT_TIMEOUT) {
          violated(i + 1, pollIdx + 1, line.trim());
        }
      }
    }
  },
};

export default rule;
