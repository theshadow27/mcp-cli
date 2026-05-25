/**
 * @rule dotw-todo-needs-issue
 * @expect 0
 * @path packages/core/src/example-guards.ts
 *
 * Guard shapes that must NOT be flagged even though they LOOK like they
 * might match. The only positions skipped are string-literal contexts
 * (`//` preceded by `"`, `'`, or `` ` ``) — every other position is
 * enforced.
 *
 *   1. dotw-todo inside a double-quoted string — preceded by `"`
 *   2. dotw-todo inside a single-quoted string — preceded by `'`
 *   3. dotw-todo inside a template literal — preceded by `` ` ``
 *   4. dotw-todo-needs-issue as an identifier — `dotw-todo` is not
 *      followed by whitespace, so the regex's `\s+` requirement fails
 *   5. prose containing "dotw-todo" without a leading `//`
 *   6. the literal `<rule-id>` placeholder — `[\w-]+` rejects `<`, so the
 *      whole pattern fails to match
 */

const docExample = "// dotw-todo some-rule: example without an issue ref appears in error messages";
const singleQuoted = '// dotw-todo some-rule: same shape in single quotes';
const templated = `// dotw-todo some-rule: same shape in a template literal`;
const ruleId = "dotw-todo-needs-issue";
const note = "the dotw-todo form should reference an issue";
const template = "// dotw-todo <rule-id>: <desc>";

export { docExample, singleQuoted, templated, ruleId, note, template };
