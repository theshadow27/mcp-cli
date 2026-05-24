import { join } from "node:path";
import { Glob } from "bun";

import type { Rule } from "./rule";

const RULES_DIR = join(import.meta.dir, "..");

function validateRule(rel: string, rule: unknown): asserts rule is Rule {
  if (!rule || typeof rule !== "object" || !("id" in rule) || !("kind" in rule)) {
    throw new Error(`${rel}: default export is not a Rule (missing id/kind)`);
  }
  const r = rule as Record<string, unknown>;
  if (r.kind === "pattern") {
    if (!(r.pattern instanceof RegExp)) {
      throw new Error(`${rel}: pattern rule '${r.id}' is missing a 'pattern' RegExp`);
    }
  } else if (r.kind === "check") {
    if (typeof r.check !== "function") {
      throw new Error(`${rel}: check rule '${r.id}' is missing a 'check' function`);
    }
  } else {
    throw new Error(`${rel}: rule '${r.id}' has unknown kind '${r.kind}' (expected 'pattern' or 'check')`);
  }
}

export async function loadAllRules(rulesDir: string = RULES_DIR): Promise<readonly Rule[]> {
  const glob = new Glob("*.rule.ts");
  const entries: { rule: Rule; file: string }[] = [];

  for await (const rel of glob.scan({ cwd: rulesDir, absolute: false })) {
    const absPath = join(rulesDir, rel);
    const mod: unknown = await import(absPath);
    const rule = (mod as { default?: unknown }).default;
    validateRule(rel, rule);
    entries.push({ rule, file: rel });
  }

  entries.sort((a, b) => a.rule.id.localeCompare(b.rule.id));

  const seen = new Map<string, string>();
  for (const { rule, file } of entries) {
    const prev = seen.get(rule.id);
    if (prev) {
      throw new Error(`duplicate rule.id '${rule.id}' in ${file} (already defined in ${prev})`);
    }
    seen.set(rule.id, file);
  }

  return entries.map((e) => e.rule);
}
