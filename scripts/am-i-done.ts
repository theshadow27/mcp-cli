#!/usr/bin/env bun
/**
 * `am-i-done` — the unified oracle for "did I run every check?"
 *
 *   bun run am-i-done                  # full suite, sh mode (default)
 *   bun run am-i-done --pre-commit     # fast subset for the pre-commit hook
 *   bun run am-i-done --pre-push       # comprehensive subset for pre-push / CI
 *   bun run am-i-done --from 3         # resume at step 3 (number or name substring)
 *   bun run am-i-done --only typecheck # run a single step
 *   bun run am-i-done --verbose        # don't hide successful step output
 *
 * In an AI context (CLAUDECODE / AGENT / MCP_CLI_AI env), all step output
 * is redirected to `build/am-i-done-<timestamp>.txt` and only the file
 * path is surfaced on failure. The file is deleted on success. This is
 * the load-bearing behaviour for mcp-cli — failing typecheck dumps
 * hundreds of lines that otherwise blow out the orchestrator's context.
 *
 * Steps that are themselves standalone scripts (typecheck, lint, test,
 * coverage) run as shell commands. Rule checks run in-process via the
 * doing-it-wrong adapter — no second bun startup.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectContext, isPreCommit, isPrePush } from "./_runner/context";
import { createAiFileLogger, createConsoleLogger } from "./_runner/logger";
import { StepRunner } from "./_runner/runner";
import type { Step } from "./_runner/types";
import { doingItWrongStep } from "./doing-it-wrong";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// ===== Step library =====
//
// Each step is declarative — name, description, command. Existing
// scripts (`bun scripts/check-*.ts`, etc.) are wrapped as string
// commands. The rule engine runs in-process via doingItWrongStep.

const TYPECHECK: Step = {
  name: "typecheck",
  description: "tsc --noEmit across all packages",
  command: "bun --bun tsc -b",
  onFailure: ["fix type errors before continuing", "run with --only typecheck to iterate fast"],
};

const LINT: Step = {
  name: "lint",
  description: "biome check --write (auto-fix where safe)",
  command: "bunx biome check --write .",
  onFailure: ["run `bunx biome check .` to see unfixable issues"],
};

const LINT_CHECK: Step = {
  name: "lint",
  description: "biome check (no auto-fix; pre-commit/pre-push mode)",
  command: "bunx biome check .",
  onFailure: ["run `bun run lint` locally to auto-fix"],
};

const ARGS_BOUNDS: Step = {
  name: "args-bounds",
  description: "post-increment arg-array access requires bounds check or suppression comment",
  command: "bun scripts/check-args-bounds.ts",
};

const TIMEOUTS: Step = {
  name: "test-timeouts",
  description: "no setTimeout-based waits in *.spec.ts (use polling instead)",
  command: "bun scripts/check-test-timeouts.ts",
};

const TEARDOWN: Step = {
  name: "session-teardown",
  description: "this.sessions.delete must precede the first await",
  command: "bun scripts/check-session-teardown.ts",
};

const PHASE_DRIFT: Step = {
  name: "phase-drift",
  description: "phase.ts run-block must call assertNoDrift",
  command: "bun scripts/check-phase-drift.ts",
};

const RULES: Step = {
  name: "doing-it-wrong",
  description: "architectural rule engine (scripts/rules/*.rule.ts)",
  command: doingItWrongStep,
  source: "scripts/doing-it-wrong.ts",
  onFailure: [
    "see the rule-by-rule guidance above",
    "run `bun scripts/doing-it-wrong.ts --rule <id>` to iterate on one rule",
    "permanent exception: // dotw-ignore <rule-id>: <reason>",
    "temporary exception: // dotw-todo <rule-id>: <desc> — fix in #NNN",
  ],
};

const TEST: Step = {
  name: "test",
  description: "bun test --parallel",
  command: "bun test --parallel",
};

const COVERAGE: Step = {
  name: "coverage",
  description: "ratchet — never lower thresholds (see scripts/check-coverage.ts)",
  command: "bun scripts/check-coverage.ts",
};

// ===== Step lists per mode =====
//
// Pre-commit: fast feedback during `git commit`. Skips full test run
//   (already covered by pre-push / CI) but keeps the architectural
//   checks — they're cheap and catch the easy bugs early.
//
// Pre-push / default: comprehensive. Includes the full test suite and
//   coverage ratchet. This is what CI also runs.

const PRE_COMMIT: Step[] = [TYPECHECK, LINT_CHECK, ARGS_BOUNDS, TIMEOUTS, TEARDOWN, PHASE_DRIFT, RULES];
const COMPREHENSIVE: Step[] = [TYPECHECK, LINT, ARGS_BOUNDS, TIMEOUTS, TEARDOWN, PHASE_DRIFT, RULES, TEST, COVERAGE];

function selectSteps(): { steps: Step[]; label: string } {
  if (isPreCommit) return { steps: PRE_COMMIT, label: "pre-commit" };
  if (isPrePush) return { steps: COMPREHENSIVE, label: "pre-push" };
  return { steps: COMPREHENSIVE, label: "default" };
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const { steps, label } = selectSteps();
  const xc = detectContext();
  const aiLogger = xc === "ai" && !argv.includes("--verbose") ? createAiFileLogger(REPO_ROOT) : null;
  const logger = aiLogger ?? createConsoleLogger();

  process.stdout.write(`🤔 am-i-done? — ${label} mode (${steps.length} step${steps.length === 1 ? "" : "s"})\n\n`);

  const runner = new StepRunner({
    logger,
    from: parseFlag(argv, "--from"),
    only: parseFlag(argv, "--only"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
  });
  runner.add(...steps);
  const report = await runner.run();

  if (aiLogger) {
    await aiLogger.finalize(report.success);
    if (!report.success) {
      process.stderr.write(`\nfull logs: ${aiLogger.path}\n`);
    }
  }

  if (report.success) {
    process.stdout.write(`\n✅ all checks passed (${report.totalMs}ms)\n`);
    process.exit(0);
  } else {
    process.stderr.write(`\n❌ ${report.failures.length} step(s) failed in ${label} mode\n`);
    process.exit(1);
  }
}

const HELP = `am-i-done — unified development readiness check

Usage:
  bun run am-i-done [--pre-commit | --pre-push] [--from N] [--only NAME] [--verbose]

Flags:
  --pre-commit   fast subset suitable for the pre-commit hook
  --pre-push     comprehensive (default for CI / pre-push)
  --from N       resume from step N (number or name substring)
  --only N       run exactly one step
  --verbose      show captured step output even on success

In a Claude / AI context (CLAUDECODE / AGENT / MCP_CLI_AI env var set),
step output is captured to build/am-i-done-<timestamp>.txt and only the
path is surfaced on failure. This is intentional — it prevents typecheck
or test failures from blowing out the orchestrator context budget.

See scripts/ROADMAP.md for the migration plan to consolidate the
standalone check-*.ts scripts into the doing-it-wrong rule engine.
`;

if (import.meta.main) {
  await main();
}
