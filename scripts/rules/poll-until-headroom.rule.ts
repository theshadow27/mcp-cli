/**
 * Rule: poll-until-headroom
 *
 * The invariant: a `pollUntil` deadline must sit safely *below* Bun's 5000ms
 * per-test watchdog, so pollUntil's own descriptive error wins the race over
 * the generic "test timed out". A deadline at or above the watchdog can never
 * fire — the watchdog kills the test first, producing a flake with a useless
 * message under CI pressure.
 *
 * Flag `pollUntil(fn, N)` where N ≥ the file's effective test watchdog — a
 * deadline at or above it can never fire its own error. The watchdog is Bun's
 * 5000ms default, or the file's `setDefaultTimeout(N)` when larger: a slow
 * suite that raises the test timeout to 30s may legitimately poll for 10s.
 *
 * Calls with *no* explicit timeout are NOT flagged: the harness default is
 * 1500ms (#2273), well under the watchdog, so the bare call is the correct,
 * idiomatic form. Don't sprinkle per-test timeouts — fix the default once and
 * rely on it (Bun's own discipline: a sane default + file-level
 * `setDefaultTimeout` for genuinely-slow suites, never per-call deadlines).
 * If a condition genuinely needs ≥5000ms, raise the file's `setDefaultTimeout`
 * above it and pass the matching explicit deadline — a deadline ≥ the test
 * timeout is otherwise a no-op.
 */

import type { CheckRule } from "./_engine/rule";

const BUN_TEST_WATCHDOG_MS = 5000;

/**
 * The effective per-test watchdog for a file: Bun's 5000ms default, raised to
 * the largest `setDefaultTimeout(N)` literal the file declares. A pollUntil
 * deadline must stay below this to surface its own error.
 */
function effectiveWatchdog(content: string): number {
  let max = BUN_TEST_WATCHDOG_MS;
  const re = /setDefaultTimeout\(\s*([0-9_.]+)\s*\)/g;
  for (const m of content.matchAll(re)) {
    const n = parseNumericLiteral(m[1]);
    if (n !== null && n > max) max = n;
  }
  return max;
}

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
 * Find the start of a real line-comment `//` on a line, ignoring `//` that
 * appears inside a string literal. Returns -1 if there is no line comment.
 */
function realCommentStart(line: string): number {
  let inStr: '"' | "'" | "`" | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (inStr !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (ch === "/" && line[i + 1] === "/") {
      return i;
    }
  }
  return -1;
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
    "pollUntil() called with a timeout ≥ the file's effective test watchdog (Bun's 5000ms default, or setDefaultTimeout(N) when the file raises it) — the watchdog fires first, so this deadline never surfaces its own error (flaky under CI pressure)",
  guidance: [
    "drop the explicit timeout and rely on the 1500ms harness default — it already has ample headroom under the watchdog",
    "a condition should resolve in milliseconds, not seconds; if you need ≥5s the test waits on time, not a condition",
    "if a suite is genuinely slow, raise the file's setDefaultTimeout above the deadline — a deadline ≥ the test timeout is a no-op",
    "if the file sets setDefaultTimeout(N) where N > 5000ms, the effective watchdog is N (not 5000ms) — explicit pollUntil timeouts below N are valid; the rule only flags timeouts ≥ the effective watchdog",
    'quote from Bun\'s own test discipline: "You are not testing the TIME PASSING, you are testing the CONDITION"',
    "cross-reference test/CLAUDE.md flaky-prevention patterns",
  ],
  documentation: "#2248",
  appliesToTests: true,
  check({ file, violated }) {
    const watchdog = effectiveWatchdog(file.content);
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pollIdx = line.indexOf("pollUntil(");
      if (pollIdx === -1) continue;

      // Skip commented-out calls: if a real "//" (not inside a string literal)
      // appears before pollUntil on the line, the call is dead code (#2293, #2371).
      const commentStart = realCommentStart(line);
      if (commentStart !== -1 && commentStart < pollIdx) continue;

      // parenOffset points to the '(' of the call
      const parenOffset = pollIdx + "pollUntil".length;
      const callText = collectCall(lines, i, parenOffset);
      if (!callText) continue;

      // inner = everything between the outer parens
      const inner = callText.slice(1, -1);
      const commaIdx = firstTopLevelComma(inner);

      // No second argument → relies on the safe 1500ms harness default — clean.
      if (commaIdx === -1) continue;

      // Explicit numeric deadline at or above the watchdog can never fire its
      // own error — the watchdog kills the test first. Bound the second arg at
      // the next top-level comma so a trailing comma or a third argument
      // (intervalMs) doesn't defeat the numeric parse.
      const rest = inner.slice(commaIdx + 1);
      const nextComma = firstTopLevelComma(rest);
      const secondArgRaw = (nextComma === -1 ? rest : rest.slice(0, nextComma)).trim();
      // Strip inline comments so `10_000 // daemon startup` parses as 10000 (#2292).
      const secondArg = secondArgRaw.replace(/\s*\/\/.*$/, "");
      const num = parseNumericLiteral(secondArg);
      if (num !== null && num >= watchdog) {
        violated(i + 1, pollIdx + 1, line.trim());
      }
    }
  },
};

export default rule;
