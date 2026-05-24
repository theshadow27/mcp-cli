/**
 * @rule dotw-todo-needs-issue
 * @expect 1
 * @path packages/core/src/example-without-issue.ts
 *
 * A dotw-todo without a #<number> reference should be flagged.
 */

const value = 42;

// dotw-todo some-rule: will fix this later
const legacy = value + 1;
