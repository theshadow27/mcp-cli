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
      if (!line.includes("satisfies never")) continue;

      // Skip lines that are purely comments.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      // Look backward (up to 40 lines) for a default: or terminal else opener.
      const lookbackStart = Math.max(0, i - 40);
      let branchStart = -1;
      for (let j = i; j >= lookbackStart; j--) {
        if (BRANCH_OPENER.test(lines[j] ?? "")) {
          branchStart = j;
          break;
        }
      }
      if (branchStart === -1) continue;

      // Search the branch body for a throw statement (from opener to a small
      // lookahead beyond the satisfies-never line).
      const lookForwardEnd = Math.min(lines.length - 1, i + 10);
      let hasThrow = false;
      for (let j = branchStart; j <= lookForwardEnd; j++) {
        if (/\bthrow\b/.test(lines[j] ?? "")) {
          hasThrow = true;
          break;
        }
      }

      if (!hasThrow) {
        violated(i + 1, line.indexOf("satisfies never") + 1, trimmed);
      }
    }
  },
};

export default rule;
