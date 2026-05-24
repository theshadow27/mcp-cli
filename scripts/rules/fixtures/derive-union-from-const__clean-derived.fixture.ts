/**
 * @rule derive-union-from-const
 * @expect 0
 * @path packages/core/src/example-clean.ts
 *
 * The type is derived via (typeof X)[number] — no duplication. Clean.
 */

export const STATUS_VALUES = ["pending", "active", "done"] as const;

export type Status = (typeof STATUS_VALUES)[number];
