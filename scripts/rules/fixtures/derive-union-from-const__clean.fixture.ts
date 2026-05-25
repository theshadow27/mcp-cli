/**
 * @rule derive-union-from-const
 * @expect 0
 * @path packages/core/src/example-clean.ts
 *
 * Shapes that must NOT be flagged:
 *   1. type derived from array via (typeof X)[number]
 *   2. union with members not matching any as-const array
 *   3. union with non-string members (mixed)
 *   4. single-member union (below the 2-member threshold)
 *   5. as-const array with no matching union at all
 *   6. union duplicates a NON-EXPORTED const array — non-exported arrays are
 *      local helpers, not the canonical source the rule guards
 */

// Shape 1: correctly derived — canonical pattern
export const SCOPES = ["user", "project", "local"] as const;
export type Scope = (typeof SCOPES)[number];

// Shape 2: union whose members don't appear in any const array
export const COLORS = ["red", "green", "blue"] as const;
export type Unrelated = "alpha" | "beta" | "gamma";

// Shape 3: mixed union (not all string literals) — rule bails out
export const MODES = ["fast", "slow"] as const;
export type MixedUnion = "fast" | "slow" | number;

// Shape 4: single-member union — below threshold
export const SINGLES = ["only"] as const;
export type Single = "only";

// Shape 5: const array with no type alias duplication
export const STATUSES = ["pending", "active", "done"] as const;

// Shape 6: NON-EXPORTED const array — must NOT be considered the source.
// Local helpers are intentionally allowed to coexist with hand-written types
// without triggering the "derive from array" guidance.
const internalKinds = ["a", "b", "c"] as const;
export type LocalKind = "a" | "b" | "c";
