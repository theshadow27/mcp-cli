/**
 * @rule no-triplicate-allow-parsing
 * @expect 1
 * @path packages/command/src/commands/claude.ts
 *
 * Constructing the paren-match regex via new RegExp() should be flagged —
 * exercises signal-2 (RegExp constructor) in isolation.
 */

export function buildParenMatcher() {
  return new RegExp("^(\\w+)\\((.+)\\)$");
}
