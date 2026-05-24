/**
 * @rule derive-union-from-const
 * @expect 2
 * @path packages/core/src/example-flagged.ts
 *
 * Two shapes that MUST be flagged:
 *   1. hand-copied union that exactly matches the as-const array
 *   2. union that is a strict subset of the as-const array
 */

// Shape 1: exact copy of the array values
export const CONFIG_SCOPES = ["user", "project", "local"] as const;
export type ConfigScope = "user" | "project" | "local";

// Shape 2: strict subset — union has fewer members than the array
export const ALL_EVENTS = ["start", "stop", "pause", "resume"] as const;
export type CoreEvent = "start" | "stop";
