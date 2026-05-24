import { resolve } from "node:path";
import { Glob } from "bun";
import { z } from "zod";

import type { Rule } from "./rule";

const RULES_DIR = resolve(import.meta.dir, "..");

const PatternRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("pattern"),
  pattern: z.instanceof(RegExp),
  scold: z.string().min(1),
  guidance: z.array(z.string()),
  documentation: z.string().optional(),
  appliesToTests: z.boolean().optional(),
  except: z.array(z.string()).optional(),
});

const CheckRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("check"),
  check: z.custom<(ctx: unknown) => void>((v) => typeof v === "function", "expected a function"),
  scold: z.string().min(1),
  guidance: z.array(z.string()),
  documentation: z.string().optional(),
  appliesToTests: z.boolean().optional(),
});

const RuleSchema = z.discriminatedUnion("kind", [PatternRuleSchema, CheckRuleSchema]);

function validateRule(rel: string, rule: unknown): asserts rule is Rule {
  if (!rule || typeof rule !== "object" || !("id" in rule) || !("kind" in rule)) {
    throw new Error(`${rel}: default export is not a Rule (missing id/kind)`);
  }
  const result = RuleSchema.safeParse(rule);
  if (!result.success) {
    const r = rule as Record<string, unknown>;
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${rel}: rule '${r.id}' failed validation: ${issues}`);
  }
}

export async function loadAllRules(rulesDir: string = RULES_DIR): Promise<readonly Rule[]> {
  const absRulesDir = resolve(rulesDir);
  const glob = new Glob("**/*.rule.{ts,tsx}");
  const entries: { rule: Rule; file: string }[] = [];

  for await (const rel of glob.scan({ cwd: absRulesDir, absolute: false })) {
    const absPath = resolve(absRulesDir, rel);
    const mod: unknown = await import(absPath);
    const rule = (mod as { default?: unknown }).default;
    validateRule(rel, rule);
    entries.push({ rule: Object.freeze({ ...rule } as Rule), file: rel });
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

  return Object.freeze(entries.map((e) => e.rule)) as readonly Rule[];
}
