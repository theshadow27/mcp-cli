/**
 * Shared spawn argument parsing for `mcx claude spawn` and `mcx codex spawn`.
 *
 * Common flags: --task/-t, --allow, --allow-only, --cwd, --timeout, --model/-m, --wait
 * Provider-specific flags are handled by callers via the `extra` hook.
 */

import { resolve } from "node:path";
import { looksLikeToolName, resolveModelName, validateAllowPatterns } from "@mcp-cli/core";
import { parseFlags } from "../flags";

export { looksLikeToolName } from "@mcp-cli/core";

export interface SharedSpawnArgs {
  task: string | undefined;
  allow: string[];
  /** When true, --allow replaces DEFAULT_SAFE_TOOLS instead of extending them. */
  allowOnly: boolean;
  cwd: string | undefined;
  timeout: number | undefined;
  model: string | undefined;
  wait: boolean;
  error: string | undefined;
  /** Non-fatal warnings (footgun patterns detected in --allow). */
  warnings: string[];
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
  const rawAllow: string[] = [];
  let allowOnly = false;
  let sawAllow = false;
  let sawAllowOnly = false;
  let allowError: string | undefined;
  const remaining: string[] = [];

  // Phase 1: extract --allow/--allow-only (greedy looksLikeToolName) and handle extra callback
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

    if (arg === "--allow" || arg === "--allow-only") {
      if (arg === "--allow") sawAllow = true;
      if (arg === "--allow-only") {
        sawAllowOnly = true;
        allowOnly = true;
      }
      // dotw-ignore no-manual-arg-parsing: greedy multi-value consume with looksLikeToolName heuristic cannot be expressed in parseFlags
      while (i + 1 < args.length && looksLikeToolName(args[i + 1])) {
        rawAllow.push(args[++i]); // dotw-ignore no-manual-arg-parsing: greedy multi-value loop
      }
      if (rawAllow.length === 0) allowError = `${arg} requires at least one tool pattern`;
    } else {
      remaining.push(arg);
    }
  }

  // Mutual exclusivity
  if (sawAllow && sawAllowOnly) {
    allowError ??= "--allow and --allow-only are mutually exclusive";
  }

  // Validate: comma-split + dead-pattern detection via shared module
  const validation = validateAllowPatterns(rawAllow);
  const allow = validation.patterns;
  const warnings = [...validation.warnings];

  // Dead patterns are errors
  if (validation.errors.length > 0) {
    allowError ??= validation.errors[0];
  }

  // Phase 2: parseFlags for standard flags
  // timeout is type "string" because Number() accepts hex/scientific/Infinity which
  // parseFlags's parseDecimal would reject — we validate with Number() in post-processing.
  const { flags, positionals, errors } = parseFlags(remaining, {
    task: { type: "string", alias: "t" },
    cwd: { type: "string" },
    timeout: { type: "string" },
    model: { type: "string", alias: "m" },
    wait: { type: "boolean" },
  });

  // Phase 3: post-processing and validation
  let error: string | undefined = allowError;

  // Timeout: Number() semantics (accepts hex, scientific, Infinity)
  let timeout: number | undefined;
  if (flags.timeout !== undefined) {
    timeout = Number(flags.timeout as string);
    if (Number.isNaN(timeout)) error ??= "--timeout must be a number";
  }

  // Model: custom validation (startsWith("-") check + null/none/undefined guard)
  let model: string | undefined;
  if (flags.model !== undefined) {
    const val = flags.model as string;
    if (val.startsWith("-")) {
      error ??= "--model requires a value";
    } else if (val.toLowerCase() === "null" || val.toLowerCase() === "none" || val.toLowerCase() === "undefined") {
      error ??= `--model "${val}" is not a valid model name (use: fable, opus, sonnet, haiku, or a full model ID)`;
    } else {
      model = resolveModelName(val);
    }
  }

  // Cwd: resolve path
  let cwd: string | undefined;
  if (flags.cwd !== undefined) {
    cwd = resolve(flags.cwd as string);
  }

  // Map parseFlags errors to match original error messages
  if (!error && errors.length > 0) {
    for (const e of errors) {
      // Normalize alias references: "-m requires a value" → "--model requires a value"
      if (e === "-m requires a value" || e === "--model requires a value") {
        error = "--model requires a value";
      } else if (e === "-t requires a value" || e === "--task requires a value") {
        error = "--task requires a value";
      } else if (e === "--timeout requires a value") {
        error = "--timeout requires a value in ms";
      } else if (e === "--cwd requires a value") {
        error = "--cwd requires a path";
      } else {
        error = e;
      }
      break;
    }
  }

  // Task: from --task flag, or first non-"-" positional (bare "-" is silently dropped)
  const task = (flags.task as string | undefined) ?? positionals.find((p) => p !== "-") ?? undefined;
  const wait = (flags.wait as boolean | undefined) ?? false;

  return { task, allow, allowOnly, cwd, timeout, model, wait, error, warnings };
}
