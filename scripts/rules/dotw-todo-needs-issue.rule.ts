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
 * Scope guard: the only positions we skip are inside string literals —
 * `//` immediately preceded by a quote or backtick (`"`, `'`, `` ` ``) is
 * prose (test fixtures, error messages, documentation source), not a
 * suppression comment. Every other position IS enforced, including
 * `foo();// dotw-todo …` with no space before `//` — that form is honored
 * as a real suppression by `_engine/suppression.ts`, so the meta-rule
 * must match it too or it becomes a silent bypass. The `dotw-todo`
 * literal must also be followed by whitespace, so identifiers like
 * `dotw-todo-needs-issue` do not match.
 */

import type { CheckRule } from "./_engine/rule";

const TODO_RE = /\/\/\s*dotw-todo\s+([\w-]+)\s*:\s*(.+)$/;
const ISSUE_RE = /#\d+/;
const STRING_LITERAL_QUOTES = new Set(['"', "'", "`"]);

const rule: CheckRule = {
  id: "dotw-todo-needs-issue",
  kind: "check",
  scold: "dotw-todo suppression comment is missing a #<number> issue reference",
  guidance: [
    "append an issue reference like `— fix in #1234` (a real issue number, not the literal placeholder `#NNN`)",
    "example accepted: // dotw-todo no-error-message-sniffing: legacy path during refactor — fix in #1234",
    "example flagged:  // dotw-todo no-error-message-sniffing: will fix this later",
    "without a numeric `#<digits>` ref the todo decays into a silent dotw-ignore — nothing to grep, nothing to close",
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
      if (preceding !== undefined && STRING_LITERAL_QUOTES.has(preceding)) continue;
      if (ISSUE_RE.test(m[2] ?? "")) continue;
      violated(i + 1, matchIdx + 1, line.trim());
    }
  },
};

export default rule;
