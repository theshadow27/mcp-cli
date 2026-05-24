/**
 * Rule: no-manual-arg-parsing
 *
 * Flag hand-rolled `args[++i]`, `args[i + 1]`, and `argv.shift()` patterns
 * inside command files. These are the source of the "next flag consumed as
 * value" bug class (e.g. `--repo --all` silently setting repo = "--all").
 *
 * The fix is to use `parseFlags(argv, specs)` from `packages/command/src/flags.ts`,
 * which centralizes bounds checks, `-`-prefix rejection, `--flag=value`,
 * numeric coercion, and unknown-flag detection.
 */

import type { CheckRule } from "./_engine/rule";

const MANUAL_PATTERNS = [
  /args\[\+\+i\]/,
  /args\[i\s*\+\s*1\]/,
  /argv\.shift\(\)/,
  /allArgs\[\+\+i\]/,
  /allArgs\[i\s*\+\s*1\]/,
];

const rule: CheckRule = {
  id: "no-manual-arg-parsing",
  kind: "check",
  scold: "manual args[++i] / args[i+1] / argv.shift() flag parsing — use parseFlags() instead",
  guidance: [
    "use parseFlags(argv, specs) from packages/command/src/flags.ts",
    "parseFlags handles bounds checks, rejects -prefixed values, supports --flag=value and numeric coercion",
    "for complex multi-value flags, consider the repeatable option in FlagSpec",
  ],
  documentation: "#2250",
  appliesToTests: false,
  check({ file, violated }) {
    if (!file.relPath.startsWith("packages/command/src/commands/")) return;

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      for (const pattern of MANUAL_PATTERNS) {
        const m = pattern.exec(line);
        if (m) {
          violated(i + 1, (m.index ?? 0) + 1, line.trim());
          break;
        }
      }
    }
  },
};

export default rule;
