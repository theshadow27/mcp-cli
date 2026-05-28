/**
 * @rule warn-on-dead-allow-pattern
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Valid allow patterns should not trigger the rule.
 */

const validPatterns = ["Bash", "Bash(:*)", "mcp__echo__add"];
const withArgs = ["Bash(git:*)", "Read(src/**/*.ts)"];
