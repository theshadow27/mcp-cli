/**
 * Bash command matching for permission evaluation.
 *
 * Supports:
 * - Exact match: command === prefix (e.g., "npm run build")
 * - Prefix match: command.startsWith(prefix) (e.g., "git " matches "git push")
 * - Compound rejection: refuse prefix/wildcard on commands with &&, ||, ;, |
 */

/** Operators that indicate compound commands. */
const COMPOUND_OPERATORS = ["&&", "||", ";", "|"];

/**
 * Patterns that indicate command substitution or injection vectors.
 * These allow arbitrary code execution inside an otherwise-safe prefix match.
 */
const SUBSTITUTION_PATTERNS = ["$(", "`", "<(", ">("];

/**
 * Check if a command string is compound (contains shell operators)
 * or contains command substitution patterns.
 *
 * Compound commands are rejected for prefix/wildcard rules because
 * `git status && rm -rf /` should not match `Bash(git *)`.
 *
 * Command substitutions like `$(...)` and backticks are also rejected
 * because they allow arbitrary execution inside a permitted prefix.
 *
 * Note: This is a cooperative guardrail, not a security boundary.
 * It uses naive string matching and does not parse shell quoting,
 * so `git commit -m "a && b"` will be falsely rejected.
 */
export function isCompoundCommand(command: string): boolean {
  if (COMPOUND_OPERATORS.some((op) => command.includes(op))) return true;
  if (SUBSTITUTION_PATTERNS.some((p) => command.includes(p))) return true;
  if (command.includes("\n")) return true;
  return false;
}

/**
 * Match a Bash command against an argument prefix pattern.
 *
 * Returns true if:
 * 1. The command starts with the prefix, AND
 * 2. The command is NOT a compound command (unless the prefix is the full command)
 */
export function matchBashCommand(command: string, argPrefix: string): boolean {
  if (!command.startsWith(argPrefix)) return false;

  // Exact match always passes (no compound check needed)
  if (command === argPrefix || command === argPrefix.trimEnd()) return true;

  // Prefix/wildcard match: reject compound commands
  if (isCompoundCommand(command)) return false;

  return true;
}
