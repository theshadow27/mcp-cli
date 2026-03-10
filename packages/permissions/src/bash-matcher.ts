/**
 * Bash command matching for permission evaluation.
 *
 * Supports:
 * - Exact match: command === prefix (e.g., "npm run build")
 * - Prefix match: command.startsWith(prefix) (e.g., "git " matches "git push")
 * - Compound rejection: refuse prefix/wildcard on commands with &&, ||, ;, |
 *
 * The compound detector implements a basic shell lexer that respects
 * single and double quoting to avoid false positives on quoted operators.
 */

/**
 * Quoting context during shell lexing.
 * - none: outside any quotes
 * - single: inside '...' (everything literal)
 * - double: inside "..." (operators literal, but $() and backticks still expand)
 */
type QuoteState = "none" | "single" | "double";

/**
 * Check if a command string is compound (contains shell operators or
 * command substitution patterns) while respecting shell quoting rules.
 *
 * Single quotes: suppress everything — no operators or substitutions detected.
 * Double quotes: suppress operators (&&, ||, ;, |) but NOT $() or backticks
 *   (which still expand in real bash).
 * Process substitution (<(, >() and embedded newlines are checked outside any quotes.
 *
 * This is a cooperative guardrail, not a security boundary.
 */
export function isCompoundCommand(command: string): boolean {
  let state: QuoteState = "none";
  const len = command.length;

  for (let i = 0; i < len; i++) {
    const ch = command[i];

    // ── State transitions ──

    if (state === "none") {
      // Backslash escapes the next character outside quotes
      if (ch === "\\") {
        i++; // skip next char
        continue;
      }
      if (ch === "'") {
        state = "single";
        continue;
      }
      if (ch === '"') {
        state = "double";
        continue;
      }
    } else if (state === "single") {
      // Single quotes: no escape processing, just wait for closing quote
      if (ch === "'") {
        state = "none";
      }
      continue; // everything inside single quotes is literal
    } else if (state === "double") {
      // Backslash escapes inside double quotes (for \", \\, \$, \`, \newline)
      if (ch === "\\") {
        i++; // skip next char
        continue;
      }
      if (ch === '"') {
        state = "none";
        continue;
      }
      // $() and backticks still expand inside double quotes
      if (ch === "$" && i + 1 < len && command[i + 1] === "(") return true;
      if (ch === "`") return true;
      continue; // operators are literal inside double quotes
    }

    // ── Outside quotes: detect dangerous patterns ──

    // Embedded newlines
    if (ch === "\n") return true;

    // Compound operators: &&, ||, ;, |
    if (ch === "&" && i + 1 < len && command[i + 1] === "&") return true;
    if (ch === "|" && i + 1 < len && command[i + 1] === "|") return true;
    if (ch === ";") return true;
    if (ch === "|") return true;

    // Command substitution
    if (ch === "$" && i + 1 < len && command[i + 1] === "(") return true;
    if (ch === "`") return true;

    // Process substitution
    if (ch === "<" && i + 1 < len && command[i + 1] === "(") return true;
    if (ch === ">" && i + 1 < len && command[i + 1] === "(") return true;
  }

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
