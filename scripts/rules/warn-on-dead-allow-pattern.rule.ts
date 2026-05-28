/**
 * Rule: warn-on-dead-allow-pattern
 *
 * Catches string literals like `Bash(*)` or `Write(*)` in source files.
 * These look like permission wildcards but are dead rules — bare `(*)`
 * is not a valid wildcard syntax. The runtime validator in
 * `allow-patterns.ts` catches these, but finding them at sweep time is
 * cheaper than a runtime error in a phase script or `.mcx.yaml` config.
 *
 * Scope: non-test TypeScript files. Test files legitimately use these
 * strings as fixture inputs for the validator itself.
 */

import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "warn-on-dead-allow-pattern",
  kind: "pattern",
  appliesToTests: false,
  scold:
    'dead allow-pattern — `Tool(*)` is not a wildcard; use `"Tool"` (no parens) or `"Tool(:*)"` for prefix matching',
  pattern: /["'`]\w+\(\*\)["'`]/,
  except: ["validateAllowPatterns", "dead.pattern", "dead-pattern", "parenMatch"],
  guidance: [
    'bare `(*)` is not a permission wildcard — `"Bash(*)"`  matches nothing at runtime',
    'to allow all calls to a tool, use just the tool name: `"Bash"`',
    'for prefix matching, use the `:*` suffix: `"Bash(:*)"` or `"mcp__echo(:*)""`',
  ],
  documentation: "#2491",
};

export default rule;
