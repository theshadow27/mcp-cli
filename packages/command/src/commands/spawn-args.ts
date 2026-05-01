/**
 * Shared spawn argument parsing for `mcx claude spawn` and `mcx codex spawn`.
 *
 * Common flags: --task/-t, --allow, --cwd, --timeout, --model/-m, --wait
 * Provider-specific flags are handled by callers via the `extra` hook.
 */

import { resolve } from "node:path";
import { resolveModelName } from "@mcp-cli/core";

/**
 * Heuristic: does a string look like a tool name / pattern for --allow?
 * Tool names are PascalCase (Read, WebSearch), MCP-style (mcp__echo__add),
 * or contain wildcards (*). Worktree names and session IDs are typically
 * lowercase-kebab or hex strings.
 */
export function looksLikeToolName(s: string): boolean {
  if (s.startsWith("-")) return false;
  // Wildcards are always tool patterns
  if (s.includes("*")) return true;
  // MCP-style tool names
  if (s.startsWith("mcp_")) return true;
  // PascalCase: starts with uppercase letter
  if (/^[A-Z]/.test(s)) return true;
  return false;
}

export interface SharedSpawnArgs {
  task: string | undefined;
  allow: string[];
  cwd: string | undefined;
  timeout: number | undefined;
  model: string | undefined;
  wait: boolean;
  error: string | undefined;
}

/**
 * Parse shared spawn flags from argv.
 *
 * @param args - CLI arguments after the `spawn` subcommand
 * @param extra - Optional callback for provider-specific flags.
 *   Called with `(arg, args, index)`. Return the number of additional args consumed
 *   (0 for flag-only, 1 if the next arg was consumed), or `undefined` to skip.
 */
export function parseSharedSpawnArgs(
  args: string[],
  extra?: (arg: string, allArgs: string[], index: number) => number | undefined,
): SharedSpawnArgs {
  let task: string | undefined;
  let cwd: string | undefined;
  let timeout: number | undefined;
  let model: string | undefined;
  let wait = false;
  const allow: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Let provider-specific handler try first
    if (extra) {
      const consumed = extra(arg, args, i);
      if (consumed !== undefined) {
        i += consumed;
        continue;
      }
    }

    if (arg === "--task" || arg === "-t") {
      task = args[++i];
      if (!task) error = "--task requires a value";
    } else if (arg === "--allow") {
      while (i + 1 < args.length && looksLikeToolName(args[i + 1])) {
        allow.push(args[++i]);
      }
      if (allow.length === 0) error = "--allow requires at least one tool pattern";
    } else if (arg === "--cwd") {
      const rawCwd = args[++i];
      if (!rawCwd) {
        error = "--cwd requires a path";
      } else {
        cwd = resolve(rawCwd);
      }
    } else if (arg === "--timeout") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (arg === "--model" || arg === "-m") {
      const val = args[++i];
      if (!val) {
        error = "--model requires a value";
      } else if (val.toLowerCase() === "null" || val.toLowerCase() === "none" || val.toLowerCase() === "undefined") {
        error = `--model "${val}" is not a valid model name (use: opus, sonnet, haiku, or a full model ID)`;
      } else {
        model = resolveModelName(val);
      }
    } else if (arg === "--wait") {
      wait = true;
    } else if (!arg.startsWith("-")) {
      if (!task) task = arg;
    }
  }

  return { task, allow, cwd, timeout, model, wait, error };
}
