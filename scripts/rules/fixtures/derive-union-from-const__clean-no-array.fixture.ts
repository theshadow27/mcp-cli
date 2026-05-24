/**
 * @rule derive-union-from-const
 * @expect 0
 * @path packages/core/src/example-standalone.ts
 *
 * A string union with no matching as-const array in the same file.
 * The union is intentionally standalone.
 */

export type Color = "red" | "green" | "blue";
