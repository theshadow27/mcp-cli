/**
 * @rule no-triplicate-allow-parsing
 * @expect 0
 * @path packages/permissions/src/rule.ts
 *
 * The permissions package has its own pattern parser for permission rule
 * evaluation (a different concern from --allow input validation). It is
 * exempt from this rule.
 */

export function parsePattern(pattern: string) {
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (match) return { tool: match[1], argPattern: match[2] };
  return { tool: pattern, argPattern: null };
}
