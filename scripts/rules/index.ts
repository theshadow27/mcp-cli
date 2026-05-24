export { loadAllRules } from "./_engine/rule-loader";
export type { Rule } from "./_engine/rule";

import type { Rule } from "./_engine/rule";

export function findRule(rules: readonly Rule[], id: string): Rule | undefined {
  return rules.find((r) => r.id === id);
}
