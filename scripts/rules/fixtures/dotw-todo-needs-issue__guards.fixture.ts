/**
 * @rule dotw-todo-needs-issue
 * @expect 0
 * @path packages/core/src/example-guards.ts
 *
 * Guard shapes that must NOT be flagged even though they LOOK like they
 * might match:
 *   1. dotw-todo text inside a string literal — `//` preceded by a quote
 *   2. dotw-todo-needs-issue as an identifier — `dotw-todo` not followed
 *      by whitespace, so the regex's `\s+` requirement fails
 *   3. prose containing "dotw-todo" without a leading `//`
 *   4. the literal `<rule-id>` placeholder — `[\w-]+` rejects `<`, so the
 *      whole pattern fails to match
 */

const docExample = "// dotw-todo some-rule: example without an issue ref appears in error messages";
const ruleId = "dotw-todo-needs-issue";
const note = "the dotw-todo form should reference an issue";
const template = "// dotw-todo <rule-id>: <desc>";

export { docExample, ruleId, note, template };
