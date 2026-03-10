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
 * Check if a command string is compound (contains shell operators).
 * Compound commands are rejected for prefix/wildcard rules because
 * `git status && rm -rf /` should not match `Bash(git *)`.
 */
export function isCompoundCommand(command: string): boolean {
  return COMPOUND_OPERATORS.some((op) => command.includes(op));
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
