/**
 * Rule: no-triplicate-allow-parsing
 *
 * The canonical implementation of comma-split normalization and
 * dead-pattern detection for --allow/--allow-only lives in
 * `packages/core/src/allow-patterns.ts`. Consumers (spawn-args.ts,
 * claude.ts, agent.ts) must call `validateAllowPatterns()` — not
 * re-implement the logic inline.
 *
 * This rule flags files outside the canonical module that contain
 * signature fragments of the parsing logic: the paren-match regex
 * used for dead-pattern detection, or a comma-split loop that
 * reimplements normalization. Importing and calling the shared
 * function is fine; copying the internals is not.
 */

import type { CheckRule } from "./_engine/rule";

const CANONICAL_PATH = "packages/core/src/allow-patterns.ts";

const EXEMPT_PREFIXES = ["packages/permissions/"];

const REIMPLEMENT_SIGNALS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\(\w\+\)\\\((\.\+|\\\.)\\\)\$/,
    label: "paren-match regex (dead-pattern detection)",
  },
  {
    pattern: /\.match\(\s*\/\^\(\\w\+\)\\\(/,
    label: "paren-match regex (dead-pattern detection)",
  },
  {
    pattern: /\.split\s*\(\s*["'`,]\s*\)\s*.*(?:dead|paren|allow)/i,
    label: "comma-split with allow-pattern handling",
  },
];

const rule: CheckRule = {
  id: "no-triplicate-allow-parsing",
  kind: "check",
  appliesToTests: false,
  anchors: [CANONICAL_PATH],
  scold:
    "allow-pattern parsing logic re-implemented outside packages/core/src/allow-patterns.ts — use validateAllowPatterns() instead",
  guidance: [
    "comma-split normalization and dead-pattern detection must live only in packages/core/src/allow-patterns.ts",
    "consumers should import { validateAllowPatterns } from '@mcp-cli/core' and call it with the raw --allow values",
    "if the shared function is missing a capability you need, extend it there — do not fork the logic",
  ],
  documentation: "#2491",
  check({ file, violated, checked }) {
    if (file.relPath === CANONICAL_PATH) return;
    if (!file.relPath.startsWith("packages/")) return;
    if (EXEMPT_PREFIXES.some((p) => file.relPath.startsWith(p))) return;
    if (file.relPath.endsWith(".spec.ts") || file.relPath.endsWith(".test.ts")) return;

    checked();

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      for (const signal of REIMPLEMENT_SIGNALS) {
        if (signal.pattern.test(line)) {
          violated(i + 1, 1, line.trim());
        }
      }
    }
  },
};

export default rule;
