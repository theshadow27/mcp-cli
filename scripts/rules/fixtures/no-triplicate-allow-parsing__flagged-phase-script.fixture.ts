/**
 * @rule no-triplicate-allow-parsing
 * @expect 1
 * @path .claude/phases/impl.ts
 *
 * Phase scripts are in-scope for this rule — reimplementing paren-match
 * in .claude/phases/ should be flagged.
 */

export function checkPattern(pattern: string) {
  const m = pattern.match(/^(\w+)\((.+)\)$/);
  if (m) return { tool: m[1], args: m[2] };
  return null;
}
