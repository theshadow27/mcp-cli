/**
 * @rule dotw-todo-needs-issue
 * @expect 0
 * @path packages/core/src/example-with-issue.ts
 *
 * A dotw-todo with a #<number> reference is correctly formed — no violation.
 */

const value = 42;

// dotw-todo some-rule: migrate to new API — fix in #1234
const legacy = value + 1;
