/**
 * Shared types for the `am-i-done` step runner and `doing-it-wrong` rule
 * engine. Designed for mcp-cli specifically:
 *
 *   - Logger interface matches the runtime contract (info/warn/error/debug)
 *     so console, capture loggers, and the AI file-logger interchange.
 *   - ExecutionContext is detected from environment variables once at import
 *     time; downstream code switches on it without re-detecting.
 *   - Step.command is either a shell command (string) or a typed
 *     `ScriptFunction`. Functions get a logger + args; their return value
 *     decides success.
 *
 * Intentionally minimal: no per-context filter callbacks, no
 * workspace-aware filters. mcp-cli has one humans-and-Claude audience;
 * we add complexity if it earns its keep.
 */

export type ExecutionContext = "ai" | "ci" | "sh" | "unknown";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface StepOptions {
  args: string[];
  env: Record<string, string | undefined>;
  logger: Logger;
}

export type StepResult = {
  success: boolean;
  /** Optional one-line summary appended to the output on failure. */
  error?: string;
};

export type ScriptFunction = (opts: StepOptions) => Promise<StepResult | boolean | undefined>;

export interface Step {
  /** Human-readable label shown in progress output. */
  name: string;
  /** One-line "why this matters" — printed before the command runs. */
  description: string;
  command: string | ScriptFunction;
  /** Path to the source file for the script (cosmetic, shown to user). */
  source?: string;
  /** Extra args appended to a string command, or passed via opts.args to a function. */
  args?: string[];
  /** Override environment for this step. */
  env?: Record<string, string>;
  /** If false, a failure logs a warning but does not stop the run. */
  critical?: boolean;
  /** Free-form hints printed after a failure. */
  onFailure?: string | string[];
}
