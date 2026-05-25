/**
 * @rule dotw-todo-needs-issue
 * @expect 4
 * @path packages/core/src/example-without-issue.ts
 *
 * Shapes that MUST be flagged — dotw-todo lacking a #<number>:
 *   1. plain description, no issue ref at all
 *   2. trailing inline comment with no issue ref
 *   3. mentions "issue" in prose but no # number
 *   4. no whitespace before `//` (e.g. `;//`) — biome usually adds the
 *      space, but if it slips through, the meta-rule still enforces it
 *      (this matches what `_engine/suppression.ts` honors as a real
 *      suppression — keeping the gate tight, no bypass)
 */

const value = 42;

// dotw-todo some-rule: will fix this later
const a = value + 1;

const b = value + 2; // dotw-todo other-rule: trailing todo with no tracker

// dotw-todo flag-rule: tracked in the backlog issue, follow up soon
const c = value + 3;

const d = value + 4;// dotw-todo cramped-rule: no space before slashes — still a real suppression

export { a, b, c, d };
