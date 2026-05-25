/**
 * @rule derive-union-from-const
 * @expect 0
 * @path scripts/example-script.ts
 *
 * Files outside `packages/*\/src/` are out of scope. A duplicated union
 * exactly matching an exported `as const` array would be flagged inside
 * packages/<name>/src — here it must NOT be, proving the path scope guard.
 */

export const SCRIPT_MODES = ["dry", "real", "diff"] as const;
export type ScriptMode = "dry" | "real" | "diff";
