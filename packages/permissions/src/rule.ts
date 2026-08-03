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
 * Check if a tool name is a bare MCP server pattern (server-wide wildcard without `__*`).
 *
 * Claude Code documents two equivalent ways to allow all tools from an MCP server:
 * `mcp__server` (bare) and `mcp__server__*`. This function detects the bare form.
 *
 * Rules:
 * - Must start with "mcp__"
 * - Server name (the part after "mcp__") must be non-empty
 * - Must not contain "__" in the server name segment (that would make it exact or `__*`)
 *
 * Examples:
 * - "mcp__puppeteer"             → true  (server-wide wildcard, equivalent to mcp__puppeteer__*)
 * - "mcp__claude_ai_Google_Drive"→ true  (single underscores in server name are fine)
 * - "mcp__"                      → false (no server name)
 * - "mcp__echo__echo"            → false (has tool segment → exact match)
 * - "mcp__atlassian__*"          → false (handled by isToolWildcard)
 */
export function isBareMcpServerPattern(tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  const rest = tool.slice(5); // strip "mcp__"
  return rest.length > 0 && !rest.includes("__") && !rest.includes("*");
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
 * Validate a single rule pattern, returning an error message or null if valid.
 *
 * An argument pattern combined with a `__*` tool-name wildcard is dead: the tool
 * segment contains `*`, which `parsePattern()`'s tool regex cannot represent, so
 * the whole string is kept as a literal tool name and compared for equality
 * against the incoming tool name — which never matches.
 *
 * Note this deliberately does NOT reject the bare-server form
 * (`mcp__atlassian(query:*)`). That form parses, and it matches whenever the
 * tool input carries a `command` / `cmd` / `script` field via the unknown-tool
 * fallback in the evaluator, so rejecting it would break working rules.
 */
export function validateRulePattern(pattern: string): string | null {
  const match = pattern.match(/^([^()]+)\((.+)\)$/);
  if (!match) return null;
  const tool = match[1];
  if (isToolWildcard(tool)) {
    return `Invalid permission rule "${pattern}": argument patterns are not supported on MCP tool-name wildcards ("${tool}"). A wildcard tool segment cannot be combined with an argument pattern, so the whole string is treated as a literal tool name and matches nothing. Use an exact tool name, or drop the argument pattern.`;
  }
  return null;
}

/**
 * Throw if any rule pattern is invalid. Call this where permission config is
 * parsed, so a bad rule surfaces as an error instead of a silent deny.
 */
export function assertValidRules(rules: readonly PermissionRule[]): void {
  const errors: string[] = [];
  for (const rule of rules) {
    const error = validateRulePattern(rule.tool);
    if (error !== null) errors.push(error);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
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
