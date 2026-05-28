/**
 * @rule warn-on-dead-allow-pattern
 * @expect 0
 * @path packages/core/src/allow-patterns.ts
 *
 * The canonical allow-patterns module references dead patterns in comments
 * and validation code. Lines containing validateAllowPatterns, dead-pattern,
 * dead.pattern, or parenMatch are exempt.
 */

const result = validateAllowPatterns(["Bash(*)"]);
if (pattern.match(/dead.pattern/)) { /* ok */ }
