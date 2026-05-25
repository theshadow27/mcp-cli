/**
 * Rule: dotw-todo-needs-issue
 *
 * Flags `// dotw-todo <rule-id>: <desc>` suppression comments whose
 * description lacks a `#<number>` issue reference. The canonical form is:
 *
 *   // dotw-todo no-error-message-sniffing: legacy path during refactor — fix in #2354
 *
 * Why: a `dotw-todo` is a deferred fix. Without an issue number the
 * commitment to fix it has no anchor — the suppression decays into a
 * silent `dotw-ignore`. Tying every todo to a tracking issue keeps the
 * backlog honest and lets `gh issue close` confirm the suppression was
 * removed when the underlying work landed.
 *
 * Scope guard: the rule only matches `//` that has whitespace (or the
 * start of the line) immediately before it, so `dotw-todo` strings
 * embedded inside string literals (e.g. test fixtures, error messages,
 * documentation source) are skipped — those positions are not real
 * suppression comments. The `dotw-todo` literal must also be followed by
 * whitespace, so identifiers like `dotw-todo-needs-issue` do not match.
 */

import type { CheckRule } from "./_engine/rule";

const TODO_RE = /\/\/\s*dotw-todo\s+([\w-]+)\s*:\s*(.+)$/;
const ISSUE_RE = /#\d+/;

const rule: CheckRule = {
  id: "dotw-todo-needs-issue",
  kind: "check",
  scold: "dotw-todo suppression comment is missing a #<number> issue reference",
  guidance: [
    "append an issue reference like `— fix in #2354` (a real issue number, not a literal placeholder)",
    "example accepted: // dotw-todo no-error-message-sniffing: legacy path during refactor — fix in #2354",
    "example flagged:  // dotw-todo no-error-message-sniffing: will fix this later",
    "without `#<number>` the todo decays into a silent dotw-ignore — there's nothing to grep, nothing to close",
    "if no issue exists yet, run `gh issue create` first, then reference the returned number",
  ],
  documentation: "#2352",
  check({ file, violated }) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const m = TODO_RE.exec(line);
      if (!m) continue;
      const matchIdx = line.indexOf(m[0]);
      const preceding = matchIdx > 0 ? line[matchIdx - 1] : undefined;
      if (preceding !== undefined && !/\s/.test(preceding)) continue;
      if (ISSUE_RE.test(m[2] ?? "")) continue;
      violated(i + 1, matchIdx + 1, line.trim());
    }
  },
};

export default rule;
