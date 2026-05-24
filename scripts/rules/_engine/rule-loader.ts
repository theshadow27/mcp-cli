import { join } from "node:path";
import { Glob } from "bun";

import type { Rule } from "./rule";

const RULES_DIR = join(import.meta.dir, "..");

export async function loadAllRules(rulesDir: string = RULES_DIR): Promise<readonly Rule[]> {
  const glob = new Glob("*.rule.ts");
  const entries: Rule[] = [];

  for await (const rel of glob.scan({ cwd: rulesDir, absolute: false })) {
    const absPath = join(rulesDir, rel);
    const mod: unknown = await import(absPath);

    const rule = (mod as { default?: unknown }).default;
    if (!rule || typeof rule !== "object" || !("id" in rule) || !("kind" in rule)) {
      throw new Error(`${rel}: default export is not a Rule (missing id/kind)`);
    }
    entries.push(rule as Rule);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const seen = new Map<string, string>();
  for (const r of entries) {
    const prev = seen.get(r.id);
    if (prev) {
      throw new Error(`duplicate rule.id '${r.id}' — first seen in the glob before this entry`);
    }
    seen.set(r.id, r.id);
  }

  return entries;
}
