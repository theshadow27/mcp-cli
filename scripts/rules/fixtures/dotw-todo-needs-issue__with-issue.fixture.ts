/**
 * @rule dotw-todo-needs-issue
 * @expect 0
 * @path packages/core/src/example-with-issue.ts
 *
 * Shapes that must NOT be flagged — every dotw-todo includes a #<number>
 * issue reference, regardless of placement style:
 *   1. standalone comment above a statement
 *   2. trailing inline comment on the same line as code
 *   3. en-dash separator with "fix in #NNN"
 *   4. hash-number anywhere in the description (no separator required)
 */

const value = 42;

// dotw-todo some-rule: migrate to new API — fix in #1234
const a = value + 1;

const b = value + 2; // dotw-todo other-rule: trailing-style suppression — fix in #5678

// dotw-todo legacy-call: rewrite once the new transport ships — fix in #9012
const c = value + 3;

// dotw-todo flag-rule: blocked on #3456 landing first
const d = value + 4;

export { a, b, c, d };
