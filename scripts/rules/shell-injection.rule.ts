/**
 * Rule: shell-injection
 *
 * Flag execSync / execFileSync calls whose first argument is a template
 * literal with interpolation. Bash $() and backtick substitution survive
 * JSON.stringify; the safe alternative is spawnSync/execFileSync with an
 * args array.
 *
 * Replaces the standalone scripts/check-shell-injection.ts (~100 lines)
 * with a 25-line declaration. The walker, reporter, suppression, and
 * fixture wiring all live in _engine.
 */

import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "shell-injection",
  kind: "pattern",
  scold: "execSync/execFileSync called with an interpolated template literal — shell-injection vector",
  pattern: /\b(execSync|execFileSync)\s*\(\s*`[^`]*\$\{/,
  guidance: [
    "use spawnSync('cmd', [...args]) — bash $() and backticks survive JSON.stringify on double-quoted args",
    "if you must build a string, sanitize via shell-escape and document why an array form is impossible",
  ],
  documentation: "CLAUDE.md#no-shell-interpolation",
};

export default rule;
