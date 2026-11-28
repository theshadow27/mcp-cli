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

import type { Rule } from "am-i-done";

const CANONICAL_PATH = "packages/core/src/allow-patterns.ts";

const EXEMPT_PREFIXES = ["packages/permissions/"];

const REIMPLEMENT_SIGNALS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\/[^/]*\(\\w\+\)\\\([^/]*\//,
    label: "paren-match regex literal (dead-pattern detection)",
  },
  {
    pattern: /(?:\.match|\.test|\.exec)\(\s*\/[^/]*\(\\w\+\)\\\(/,
    label: "paren-match regex via .match/.test/.exec (dead-pattern detection)",
  },
  {
    pattern: /new\s+RegExp\(\s*["'`][^"'`]*\(\\\\w\+\)\\\\\(/,
    label: "paren-match regex via new RegExp() constructor",
  },
  {
    pattern: /\.split\s*\(\s*["'`],["'`]\s*\)\s*.*(?:dead|paren|allow)/i,
    label: "comma-split with allow-pattern handling",
  },
];

export default {
  id: "no-triplicate-allow-parsing",
  type: "check",
  category: "architecture",
  tests: "exclude",
  // `files` replaces the default include, and `.claude/` is excluded from it.
  files: ["packages/**/*.{ts,tsx}", ".claude/phases/**/*.ts"],
  anchors: [(files) => files.has(CANONICAL_PATH)],
  scold:
    "allow-pattern parsing logic re-implemented outside packages/core/src/allow-patterns.ts — use validateAllowPatterns() instead",
  guidance: [
    "comma-split normalization and dead-pattern detection must live only in packages/core/src/allow-patterns.ts",
    "consumers should import { validateAllowPatterns } from '@mcp-cli/core' and call it with the raw --allow values",
    "if the shared function is missing a capability you need, extend it there — do not fork the logic",
  ],
  documentation: "#2491",
  check(ctx) {
    const { file } = ctx;
    if (file.relativePath === CANONICAL_PATH) return ctx.skipped();
    if (EXEMPT_PREFIXES.some((p) => file.relativePath.startsWith(p))) return ctx.skipped();

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      if (REIMPLEMENT_SIGNALS.some((signal) => signal.pattern.test(line))) ctx.violated(i + 1, 1, line.trim());
    }
    return ctx.checked();
  },
} satisfies Rule;
