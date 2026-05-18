/**
 * Suppression comment parser.
 *
 * Two forms, deliberately verbose so a reviewer reading the diff knows
 * what's being suppressed and (for the temporary form) where the fix
 * lives:
 *
 *   // dotw-ignore <rule-id>: <reason>            ← permanent
 *   // dotw-todo  <rule-id>: <desc> — fix in #123 ← temporary
 *
 * A suppression applies to the line it sits on AND the next non-empty
 * line. That covers both the "comment above the violation" and
 * "comment on the same line, trailing" styles.
 *
 * The `dotw-todo` form requires a `#<number>` issue reference. A meta
 * rule (separately registered) flags todos without one. Reason: every
 * suppression that's not "this is genuinely correct" should be tracked
 * to closure.
 */

const IGNORE_RE = /\/\/\s*dotw-ignore\s+([\w-]+)\s*:\s*(.+)$/;
const TODO_RE = /\/\/\s*dotw-todo\s+([\w-]+)\s*:\s*(.+)$/;
const ISSUE_RE = /#\d+/;

export interface SuppressionMatch {
  /** true if a suppression comment for the rule applies to this line. */
  suppressed: boolean;
  /** true if a todo suppression matches but is missing a #<number>. */
  todoWithoutIssue: boolean;
  /** The form that matched, if any. */
  kind?: "ignore" | "todo";
}

/**
 * Check whether a violation at `lineNo` (1-indexed) in `content` is
 * suppressed for `ruleId`. Looks at the violation line itself and the
 * preceding line — the typical "comment above" placement.
 */
export function checkSuppression(content: string, lineNo: number, ruleId: string): SuppressionMatch {
  const lines = content.split("\n");
  // 1-indexed → 0-indexed; check this line and the one above
  const candidates = [lineNo - 1, lineNo - 2].filter((i) => i >= 0 && i < lines.length);

  for (const i of candidates) {
    const line = lines[i];
    if (line === undefined) continue;
    const ignore = IGNORE_RE.exec(line);
    if (ignore && ignore[1] === ruleId) {
      return { suppressed: true, todoWithoutIssue: false, kind: "ignore" };
    }
    const todo = TODO_RE.exec(line);
    if (todo && todo[1] === ruleId) {
      return {
        suppressed: true,
        todoWithoutIssue: !ISSUE_RE.test(todo[2] ?? ""),
        kind: "todo",
      };
    }
  }
  return { suppressed: false, todoWithoutIssue: false };
}
