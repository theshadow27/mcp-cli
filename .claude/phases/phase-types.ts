/** Shared types used across phase fn files. */

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Typed GH operations for the gh() dependency injection point.
 * Each variant maps to a specific ctx.gh method call; adapters dispatch on op.op.
 * stdout format per op:
 *   pr:labels   — newline-separated label names
 *   pr:checks   — decimal count of non-SUCCESS checks
 *   pr:comments — concatenated comment bodies (newline-joined)
 */
export type GhOp =
  | { op: "pr:labels"; prNumber: number }
  | { op: "pr:checks"; prNumber: number }
  | { op: "pr:comments"; prNumber: number };
