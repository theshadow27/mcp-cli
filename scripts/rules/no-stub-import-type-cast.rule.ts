import type { PatternRule } from "./_engine/rule";

/**
 * Rule: no-stub-import-type-cast
 *
 * Test stubs must not be forced to a shape via `as ReturnType<typeof
 * import("...").fn>`. This cast silently bypasses structural type checking:
 * if the target interface gains a new required field the stub still compiles,
 * and the mismatch is invisible at the type level. PR #2552 fixed the one
 * confirmed instance (scripts/_runner/ci-steps.spec.ts:409); this rule stops
 * the pattern from being reintroduced as the rules-engine test suite grows.
 *
 * The dynamic-import token uniquely identifies the cast, so a line-level regex
 * is sufficient — whitespace around the `<`, `typeof`, and `(` is tolerated so
 * a trivial reformat cannot slip past.
 *
 * Fix: annotate the return type directly (import the type and write
 * `(): TheType => ({...})`) or use `satisfies` so the stub is checked
 * structurally.
 */

const rule: PatternRule = {
  id: "no-stub-import-type-cast",
  kind: "pattern",
  appliesToTests: true,
  scold:
    "Suppressive 'as ReturnType<typeof import(...)>' cast in test stub — use a direct return-type annotation or 'satisfies' instead",
  pattern: /\bas\s+ReturnType\s*<\s*typeof\s+import\s*\(/,
  except: ["// dotw-ignore no-stub-import-type-cast:", "// dotw-todo no-stub-import-type-cast:"],
  guidance: [
    'import the type and annotate the return directly: `import type { T } from "..."; const stub = (): T => ({...})`',
    "or use `satisfies T` so the stub is still checked structurally",
    "the cast compiles even when T gains a new required field — that is the blind spot this rule closes",
  ],
  documentation: "#2555",
};

export default rule;
