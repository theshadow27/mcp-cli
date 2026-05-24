/**
 * @rule derive-union-from-const
 * @expect 1
 * @path packages/core/src/example.ts
 *
 * A hand-written string union whose members are a subset of an
 * exported as-const array in the same file. Should be flagged.
 */

export const STATUS_VALUES = ["pending", "active", "done"] as const;

export type Status = "pending" | "active" | "done";
