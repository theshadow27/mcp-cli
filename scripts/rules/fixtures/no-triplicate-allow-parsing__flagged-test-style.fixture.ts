/**
 * @rule no-triplicate-allow-parsing
 * @expect 1
 * @path packages/command/src/commands/agent.ts
 *
 * Using .test() with the paren-match regex should be flagged —
 * exercises signal-0 (standalone regex literal) independently of
 * signal-1 (.match/.test/.exec method call).
 */

export function hasParenSyntax(pattern: string): boolean {
  return /^(\w+)\((.+)\)$/.test(pattern);
}
