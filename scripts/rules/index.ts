/**
 * Rule registry.
 *
 * Each rule lives in its own `<id>.rule.ts` file and is imported here.
 * The order is the order rules are reported in. Adding a rule is a
 * one-line append, plus the rule file itself, plus at least one
 * fixture under `fixtures/`.
 *
 * Why not glob-import: explicit imports give type-safe export names,
 * stable ordering, and one obvious place to find every rule.
 */

import shellInjection from "./shell-injection.rule";

import type { Rule } from "./_engine/rule";

export const RULES: readonly Rule[] = [shellInjection];

export function findRule(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}
