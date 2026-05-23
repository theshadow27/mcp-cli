/**
 * Rule: no-js-extension-local-import
 *
 * Relative imports within packages/ and .claude/phases/ must use
 * extensionless specifiers (e.g. `./phase-types`, not `./phase-types.js`).
 * TypeScript resolves .ts source files without extensions at compile time,
 * and the .js suffix becomes a footgun when the import is later refactored
 * from a type-only import to a value import — the runtime extension mismatch
 * silently breaks only at that point.
 *
 * Exception: imports with an `import ... with { type: ... }` assertion are
 * text/asset imports of actual .js runtime files and are intentionally exempt.
 */

import type { CheckRule } from "./_engine/rule";

const RELATIVE_JS_IMPORT = /from\s+["'](\.\.?\/[^"']*\.js)["']/;

const rule: CheckRule = {
  id: "no-js-extension-local-import",
  kind: "check",
  scold: "relative import uses .js extension — TypeScript source files should use extensionless specifiers",
  guidance: [
    "replace './foo.js' with './foo' — the TypeScript compiler resolves the .ts source file",
    "the .js suffix becomes a footgun when refactoring from type-only to value imports",
    "exception: imports with 'with { type: ... }' (asset/text imports) are intentionally exempt",
  ],
  documentation: "#2173",
  appliesToTests: true,
  check({ file, violated }) {
    const inScope = file.relPath.startsWith("packages/") || file.relPath.startsWith(".claude/phases/");
    if (!inScope) return;

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      // Skip text/asset imports (e.g. `with { type: "text" }`) — these reference
      // actual .js runtime files, not TypeScript source.
      if (line.includes("with {") || line.includes("with{")) continue;
      const m = RELATIVE_JS_IMPORT.exec(line);
      if (m) violated(i + 1, (m.index ?? 0) + 1, line.trim());
    }
  },
};

export default rule;
