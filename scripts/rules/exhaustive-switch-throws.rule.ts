/**
 * Rule: exhaustive-switch-throws
 *
 * `satisfies never` proves exhaustiveness over the declared union at
 * compile time, but does nothing at runtime. A default branch that
 * only uses `satisfies never` silently no-ops when an unexpected value
 * arrives from a dynamic source (a JSON config, an IPC payload, a loaded
 * module). The fix is to pair it with a runtime `throw`.
 *
 * Harvested from review comments on PRs #2192 and #2080.
 */

import type { CheckRule } from "./_engine/rule";

// Matches the start of a default: case or a terminal else branch.
// "terminal" here means else NOT followed by if — we skip else-if chains.
const BRANCH_OPENER = /\bdefault\s*:|(?:^|\})\s*else\s*(?!if\b)\s*(?:\{|$)/;

/** Strip inline // comments and /* ... *\/ block comments from a single line. */
function stripComments(line: string): string {
  // Remove /* ... */ spans (non-greedy, single-line only).
  let s = line.replace(/\/\*.*?\*\//g, "");
  // Remove trailing // comment.
  const slashIdx = s.indexOf("//");
  if (slashIdx !== -1) s = s.slice(0, slashIdx);
  return s;
}

const rule: CheckRule = {
  id: "exhaustive-switch-throws",
  kind: "check",
  scold: "`satisfies never` in a default/else branch has no runtime throw — silently no-ops on unexpected values",
  guidance: [
    "pair the compile-time check with a runtime throw in the same branch:",
    "  default: { action satisfies never; throw new Error(`unhandled: ${JSON.stringify(action)}`); }",
    "or replace with an assertNever(x) helper that both narrows the type and throws",
  ],
  documentation: "#2252",
  check({ file, violated }) {
    const lines = file.content.split("\n");

    for (const [i, line] of lines.entries()) {
      const stripped = stripComments(line);
      if (!stripped.includes("satisfies never")) continue;

      // Look backward (up to 40 lines) for a default: or terminal else opener,
      // matching only on comment-stripped content so comment lines are ignored.
      const lookbackStart = Math.max(0, i - 40);
      let branchStart = -1;
      for (let j = i; j >= lookbackStart; j--) {
        if (BRANCH_OPENER.test(stripComments(lines[j] ?? ""))) {
          branchStart = j;
          break;
        }
      }
      if (branchStart === -1) continue;

      // Search the branch body for a throw statement (from opener to a small
      // lookahead beyond the satisfies-never line). Strip comments so `throw`
      // inside a string or comment doesn't count.
      const lookForwardEnd = Math.min(lines.length - 1, i + 10);
      let hasThrow = false;
      for (let j = branchStart; j <= lookForwardEnd; j++) {
        if (/\bthrow\b/.test(stripComments(lines[j] ?? ""))) {
          hasThrow = true;
          break;
        }
      }

      if (!hasThrow) {
        violated(i + 1, line.indexOf("satisfies never") + 1, line.trim());
      }
    }
  },
};

export default rule;
