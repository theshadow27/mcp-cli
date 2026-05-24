/**
 * @rule no-manual-arg-parsing
 * @expect 0
 * @path packages/command/src/commands/example-false-pos.ts
 *
 * The pattern text appearing inside comments, string literals, template
 * literals, and object literals must NOT trigger the rule. AST-based
 * detection skips these contexts structurally.
 */

declare const args: string[];

export function helpText(): string {
  // This comment mentions args[++i] and args[i + 1] — not real code.
  return "manual args[++i] parsing is unsafe";
}

export function errorMessages(): string[] {
  return [
    "use parseFlags instead of args[++i]",
    `the pattern args[i + 1] should not appear`,
    "argv.shift() is also banned",
  ];
}

export const GUIDANCE = {
  bad: "args[++i]",
  worse: "allArgs[i + 1]",
  worst: "argv.shift()",
};

export function templateExample(): string {
  const pattern = "args[i + 1]";
  return `avoid ${pattern} in new code`;
}
