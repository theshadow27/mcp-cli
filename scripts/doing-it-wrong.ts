#!/usr/bin/env bun
/**
 * `doing-it-wrong` — the rule engine entry point.
 *
 *   bun run doing-it-wrong              # all rules, all files
 *   bun run doing-it-wrong --rule X     # one rule across the tree
 *   bun run doing-it-wrong --filter Y   # filter files by path substring
 *   bun run doing-it-wrong --all        # show every violation (no per-rule cap)
 *   bun run doing-it-wrong --list       # list registered rules and exit
 *
 * The script is also callable as a ScriptFunction from am-i-done.ts so
 * the same logic runs in pre-commit / pre-push without forking a child.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFiles } from "./rules/_engine/file-loader";
import { reportViolations } from "./rules/_engine/reporter";
import { type Violation, evaluateRule } from "./rules/_engine/rule";
import { checkSuppression } from "./rules/_engine/suppression";
import { RULES } from "./rules/index";

import type { ScriptFunction } from "./_runner/types";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export interface RunRulesOptions {
  ruleId?: string;
  filter?: string;
  showAll?: boolean;
}

export async function runRules(
  opts: RunRulesOptions,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<{
  violations: Violation[];
  durationMs: number;
}> {
  const t0 = Date.now();
  const rules = opts.ruleId ? RULES.filter((r) => r.id === opts.ruleId) : RULES;
  if (opts.ruleId && rules.length === 0) {
    logger.error(`rule '${opts.ruleId}' not registered. known: ${RULES.map((r) => r.id).join(", ")}`);
    return { violations: [], durationMs: 0 };
  }

  const files = await loadFiles({ repoRoot: REPO_ROOT, filter: opts.filter });
  const violations: Violation[] = [];
  for (const file of files.values()) {
    for (const rule of rules) {
      const raw = evaluateRule(rule, file, files);
      for (const v of raw) {
        const s = checkSuppression(file.content, v.line, rule.id);
        if (s.suppressed && !s.todoWithoutIssue) continue;
        violations.push({ ...v, rule });
      }
    }
  }

  return { violations, durationMs: Date.now() - t0 };
}

/** Step adapter — lets am-i-done.ts run the rule engine in-process. */
export const doingItWrongStep: ScriptFunction = async ({ logger }) => {
  const { violations } = await runRules({}, logger);
  reportViolations(violations, { logger, showAll: false });
  return { success: violations.length === 0, error: violations.length ? `${violations.length} violations` : undefined };
};

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--list")) {
    process.stdout.write(`${RULES.map((r) => `${r.id}\t${r.scold}`).join("\n")}\n`);
    return;
  }
  const ruleIdx = argv.indexOf("--rule");
  const filterIdx = argv.indexOf("--filter");
  const opts: RunRulesOptions = {
    ruleId: ruleIdx >= 0 ? argv[ruleIdx + 1] : undefined,
    filter: filterIdx >= 0 ? argv[filterIdx + 1] : undefined,
    showAll: argv.includes("--all"),
  };
  const { violations, durationMs } = await runRules(opts, console);
  reportViolations(violations, { logger: console, showAll: opts.showAll });
  console.info(`\nchecked ${RULES.length} rule${RULES.length === 1 ? "" : "s"} in ${durationMs}ms`);
  process.exit(violations.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
