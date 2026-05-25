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
import { MissingAnchorError, type Violation, evaluateRule, validateAnchors } from "./rules/_engine/rule";
import { checkSuppression } from "./rules/_engine/suppression";
import { loadAllRules } from "./rules/index";

import type { Logger, ScriptFunction } from "./_runner/types";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export interface RunRulesOptions {
  ruleId?: string;
  filter?: string;
  showAll?: boolean;
}

export interface MalformedTodo {
  file: string;
  line: number;
  ruleId: string;
}

export interface RunRulesResult {
  violations: Violation[];
  malformedTodos: MalformedTodo[];
  unknownRule: boolean;
  ruleCount: number;
  durationMs: number;
  /** Rule IDs that ran on >0 applicable files but reported zero inspection work. */
  silentPassRules: string[];
  /** Anchor-validation failures (rule id + missing paths) — fatal for the run. */
  missingAnchors: { ruleId: string; missing: readonly string[] }[];
}

type LoggerWithDebug = Pick<Console, "info" | "warn" | "error"> & { debug?: (...args: unknown[]) => void };

function appliesToFile(rule: { appliesToTests?: boolean }, isTest: boolean): boolean {
  if (rule.appliesToTests === false && isTest) return false;
  if (rule.appliesToTests === true && !isTest) return false;
  return true;
}

export async function runRules(opts: RunRulesOptions, logger: LoggerWithDebug): Promise<RunRulesResult> {
  const t0 = Date.now();
  const allRules = await loadAllRules();
  const rules = opts.ruleId ? allRules.filter((r) => r.id === opts.ruleId) : allRules;
  if (opts.ruleId && rules.length === 0) {
    logger.error(`rule '${opts.ruleId}' not registered. known: ${allRules.map((r) => r.id).join(", ")}`);
    return {
      violations: [],
      malformedTodos: [],
      unknownRule: true,
      ruleCount: allRules.length,
      durationMs: Date.now() - t0,
      silentPassRules: [],
      missingAnchors: [],
    };
  }

  const files = await loadFiles({ repoRoot: REPO_ROOT, filter: opts.filter });

  // Anchor validation comes before any per-file evaluation: a rule whose
  // anchor file is absent from the loaded set would silently no-op every
  // file and report a spurious clean pass. Collect ALL missing-anchor
  // failures (not just the first) so a renamed-file regression that hits
  // multiple rules surfaces them together in one CI run.
  const missingAnchors: { ruleId: string; missing: readonly string[] }[] = [];
  for (const rule of rules) {
    try {
      validateAnchors(rule, files);
    } catch (e) {
      if (e instanceof MissingAnchorError) {
        missingAnchors.push({ ruleId: e.ruleId, missing: e.missing });
        logger.error(`✗ ${e.message}`);
      } else {
        throw e;
      }
    }
  }

  const violations: Violation[] = [];
  const malformedTodos: MalformedTodo[] = [];
  const silentPassRules: string[] = [];
  // Iterate rules at the outer level so violations[] (and the reporter's
  // grouping) come out in RULES registration order — independent of glob
  // iteration order on the file scan.
  for (const rule of rules) {
    let inspectionCount = 0;
    let applicableFileCount = 0;
    for (const file of files.values()) {
      if (!appliesToFile(rule, file.isTest)) continue;
      applicableFileCount++;
      const raw = evaluateRule(rule, file, files, { onChecked: () => inspectionCount++ });
      for (const v of raw) {
        const s = checkSuppression(file.content, v.line, rule.id);
        if (s.suppressed) {
          // A malformed dotw-todo (missing #NNN) is also caught by the
          // dotw-todo-needs-issue meta-rule as a standalone violation.
          // This log is supplementary — the meta-rule is the hard gate.
          if (s.todoWithoutIssue) malformedTodos.push({ file: file.relPath, line: v.line, ruleId: rule.id });
          continue;
        }
        violations.push({ ...v, rule });
      }
    }
    // Silent-pass detector: a rule that scanned applicable files but never
    // signalled any inspection work is most likely no-opping due to a
    // refactor (renamed anchor, misnamed identifier, narrowed --filter).
    // Surfaces in CI logs as debug so a regression doesn't go unnoticed.
    if (applicableFileCount > 0 && inspectionCount === 0) {
      silentPassRules.push(rule.id);
      logger.debug?.(
        `debug: rule '${rule.id}' checked 0 anchors/files across ${applicableFileCount} applicable file(s) — possible silent-pass regression`,
      );
    }
  }

  return {
    violations,
    malformedTodos,
    unknownRule: false,
    ruleCount: allRules.length,
    durationMs: Date.now() - t0,
    silentPassRules,
    missingAnchors,
  };
}

function reportMalformedTodos(malformedTodos: MalformedTodo[], logger: Pick<Console, "warn">): void {
  if (malformedTodos.length === 0) return;
  logger.warn(
    `\n⚠ ${malformedTodos.length} malformed dotw-todo comment${malformedTodos.length === 1 ? "" : "s"} (missing #<issue>):`,
  );
  for (const t of malformedTodos) logger.warn(`  ${t.file}:${t.line}  (rule: ${t.ruleId})`);
  logger.warn("  expected: // dotw-todo <rule-id>: <description> — fix in #1234 (a real issue number)");
  logger.warn("  these are also flagged by the dotw-todo-needs-issue rule as violations");
}

/** Step adapter — lets am-i-done.ts run the rule engine in-process. */
export const doingItWrongStep: ScriptFunction = async ({ logger }) => {
  const { violations, malformedTodos, unknownRule, missingAnchors } = await runRules({}, logger);
  reportViolations(violations, { logger, showAll: false });
  reportMalformedTodos(malformedTodos, logger);
  if (unknownRule) return { success: false, error: "unknown rule" };
  if (missingAnchors.length > 0) {
    return { success: false, error: `${missingAnchors.length} rule(s) with missing anchors` };
  }
  return { success: violations.length === 0, error: violations.length ? `${violations.length} violations` : undefined };
};

function isFailure(result: RunRulesResult): boolean {
  return result.unknownRule || result.violations.length > 0 || result.missingAnchors.length > 0;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--list")) {
    const allRules = await loadAllRules();
    process.stdout.write(`${allRules.map((r) => `${r.id}\t${r.scold}`).join("\n")}\n`);
    return;
  }
  const ruleIdx = argv.indexOf("--rule");
  const filterIdx = argv.indexOf("--filter");
  const opts: RunRulesOptions = {
    ruleId: ruleIdx >= 0 ? argv[ruleIdx + 1] : undefined,
    filter: filterIdx >= 0 ? argv[filterIdx + 1] : undefined,
    showAll: argv.includes("--all"),
  };
  const result = await runRules(opts, console);
  reportViolations(result.violations, { logger: console, showAll: opts.showAll });
  reportMalformedTodos(result.malformedTodos, console);
  console.info(`\nchecked ${result.ruleCount} rule${result.ruleCount === 1 ? "" : "s"} in ${result.durationMs}ms`);
  process.exit(isFailure(result) ? 1 : 0);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
