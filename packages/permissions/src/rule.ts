/**
 * Permission rule types and pattern parsing.
 *
 * Rules are the atomic unit of permission configuration:
 * - `{ tool: "Read", action: "allow" }` — allow all Read calls
 * - `{ tool: "Bash(git *)", action: "allow" }` — allow Bash when command starts with "git "
 */

export interface PermissionRule {
  /** Tool pattern: "Read", "Bash", "Bash(git *)", etc. */
  tool: string;
  action: "allow" | "deny";
}

export interface ParsedPattern {
  tool: string;
  /** The raw argument pattern inside parens, e.g., "git *" from "Bash(git *)". Null for plain tool patterns. */
  argPattern: string | null;
}

/**
 * Parse a rule pattern like "Bash(git *)" into { tool, argPattern }.
 * Plain patterns like "Read" have no argPattern.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (match) return { tool: match[1], argPattern: match[2] };
  return { tool: pattern, argPattern: null };
}

/**
 * Check if an argument pattern is a wildcard (prefix) pattern.
 *
 * Only `:*` suffix is treated as wildcard. Bare `*` is a valid bash glob
 * character (e.g., `ls /foo/*`) and should be treated as literal.
 */
export function isWildcardPattern(argPattern: string): boolean {
  return argPattern.endsWith(":*");
}

/**
 * Check if a tool name is a tool-level wildcard (prefix match on the tool name itself).
 *
 * Only `__*` suffix is treated as a tool wildcard, matching MCP tool naming
 * conventions (mcp__server__tool). A bare `*` in a tool name is never a wildcard.
 *
 * Examples:
 * - "mcp__atlassian__*" → true (matches all atlassian MCP tools)
 * - "mcp__*"            → true (matches every MCP tool from any server)
 * - "mcp__echo__echo"   → false (exact tool name)
 */
export function isToolWildcard(tool: string): boolean {
  return tool.endsWith("__*");
}

/**
 * Convert a tool wildcard pattern to the prefix for `startsWith` matching.
 * Only call this when `isToolWildcard()` returns true.
 *
 * Examples:
 * - "mcp__atlassian__*" → "mcp__atlassian__"
 * - "mcp__*"            → "mcp__"
 */
export function toToolPrefix(tool: string): string {
  return tool.slice(0, -1); // remove trailing *
}

/**
 * Convert a wildcard argument pattern (ending in `:*`) to a prefix for matching.
 *
 * The `:*` suffix is Claude Code's native format meaning "this command prefix
 * with any arguments after". The `:` is replaced by a space to form the prefix.
 *
 * Examples:
 * - "bun:*" → "bun "
 * - "git checkout:*" → "git checkout "
 * - "GH_PAGER=cat gh pr:*" → "GH_PAGER=cat gh pr "
 *
 * Only call this on patterns where `isWildcardPattern()` returns true.
 */
export function toArgPrefix(argPattern: string): string {
  return `${argPattern.slice(0, -2)} `;
}
