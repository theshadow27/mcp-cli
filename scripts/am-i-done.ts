#!/usr/bin/env bun
/**
 * `am-i-done` — the unified oracle for "did I run every check?"
 *
 *   bun run am-i-done                       # full suite, developer-friendly
 *   bun run am-i-done --pre-commit          # fast static subset (pre-commit hook)
 *   bun run am-i-done --pre-push            # matches CI exactly (pre-push hook)
 *   bun run am-i-done --ci                  # alias for --pre-push (used by ci.yml)
 *   bun run am-i-done --ci --skip coverage  # ci.yml `check` job
 *   bun run am-i-done --ci --only coverage  # ci.yml `coverage` job
 *   bun run am-i-done --from 3              # resume at step 3 (number or name)
 *   bun run am-i-done --only typecheck      # run a single step
 *   bun run am-i-done --verbose             # don't hide successful step output
 *
 * In an AI context (CLAUDECODE / AGENT / MCP_CLI_AI env), all step output
 * is redirected to `build/am-i-done-<timestamp>.txt` and only the file
 * path is surfaced on failure. The file is deleted on success. This is
 * the load-bearing behaviour for mcp-cli — failing typecheck dumps
 * hundreds of lines that otherwise blow out the orchestrator's context.
 *
 * Steps that are themselves standalone scripts (typecheck, lint) run as
 * shell commands. Rule checks run in-process via the doing-it-wrong
 * adapter — no second bun startup. CI-flavoured test and coverage steps
 * (--ci / --pre-push) run through factories in `scripts/_runner/ci-steps.ts`
 * that carry the #1004 (Bun crash-after-pass) and #1419 (coverage
 * panic-on-teardown) retry tolerance the naive shell commands lack —
 * Phase 5 of scripts/ROADMAP.md (#2345).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bunTestWithCrashTolerance, coverageWithCrashTolerance } from "./_runner/ci-steps";
import { detectContext, isCi, isPreCommit, isPrePush } from "./_runner/context";
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

const INSTALL: Step = {
  name: "install",
  description: "bun install --frozen-lockfile (no-op when deps are current)",
  command: "bun install --frozen-lockfile",
  onFailure: ["lockfile may be out of date — run `bun install` manually and commit bun.lock"],
};

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

const RULES: Step = {
  name: "doing-it-wrong",
  description: "architectural rule engine (scripts/rules/*.rule.ts)",
  command: doingItWrongStep,
  source: "scripts/doing-it-wrong.ts",
  onFailure: [
    "see the rule-by-rule guidance above",
    "run `bun scripts/doing-it-wrong.ts --rule <id>` to iterate on one rule",
    "permanent exception: // dotw-ignore <rule-id>: <reason>",
    "temporary exception: // dotw-todo <rule-id>: <desc> — fix in #1234 (a real issue number)",
  ],
};

const TEST_PARALLEL: Step = {
  name: "test-parallel",
  description: "bun test --parallel (excluding packages/control — yoga-layout TDZ, #2362)",
  command: "bun test --parallel --path-ignore-patterns=packages/control/**",
};

const TEST_CONTROL: Step = {
  name: "test-control",
  description: "bun test packages/control (sequential — yoga-layout TDZ workaround #2362)",
  command: "bun test packages/control",
};

const COVERAGE: Step = {
  name: "coverage",
  description: "ratchet — never lower thresholds (see scripts/check-coverage.ts)",
  command: "bun scripts/check-coverage.ts",
};

// ===== CI step list =====
//
// The CI audience splits tests the way ci.yml historically did: a non-daemon
// suite and a daemon suite, sequentially (no `--parallel`), each carrying the
// #1004 crash-after-pass tolerance. Coverage is the bespoke `check-coverage.ts
// --ci` path with the #1419 panic-on-teardown tolerance. The retry-and-classify
// logic lives in `scripts/_runner/ci-steps.ts` — one implementation shared by
// the pre-push hook and the CI workflow (#2345).
//
// Test paths mirror .github/workflows/ci.yml; adding a new package directory
// means updating both lists (and matching the workflow's artifact upload glob).

const NON_DAEMON_TEST_PATHS = [
  "packages/acp",
  "packages/clone",
  "packages/codex",
  "packages/command",
  "packages/control",
  "packages/core",
  "packages/opencode",
  "packages/permissions",
  "scripts/rules",
  "test/integration.spec.ts",
];

const DAEMON_TEST_PATHS = [
  "packages/daemon",
  "test/cli-orchestration.spec.ts",
  "test/daemon-integration.spec.ts",
  "test/stress.spec.ts",
  "test/transport-errors.spec.ts",
];

const TEST_NON_DAEMON_CI: Step = {
  name: "test-non-daemon",
  description: "non-daemon tests (sequential; #1004 crash-after-pass tolerance)",
  command: bunTestWithCrashTolerance({
    paths: NON_DAEMON_TEST_PATHS,
    logName: "test_non_daemon",
    retryOn132: false,
  }),
  source: "scripts/_runner/ci-steps.ts",
  onFailure: [
    "real failure: see the captured output above",
    "post-test Bun crash (#1004): summary should show `0 fail` — would have been treated as pass",
    "log artefact: /tmp/test_non_daemon.txt",
  ],
};

const TEST_DAEMON_CI: Step = {
  name: "test-daemon",
  description: "daemon tests (sequential; #1004 segfault retry + crash-after-pass tolerance)",
  command: bunTestWithCrashTolerance({
    paths: DAEMON_TEST_PATHS,
    logName: "test_daemon",
    retryOn132: true,
  }),
  source: "scripts/_runner/ci-steps.ts",
  onFailure: [
    "real failure: see the captured output above",
    "post-test Bun crash (#1004): summary should show `0 fail` — would have been treated as pass",
    "log artefact: /tmp/test_daemon.txt (retry: test_daemon_retry.txt)",
  ],
};

const COVERAGE_CI: Step = {
  name: "coverage",
  description: "coverage --ci (ratchet + #1419/#1004 retry handling)",
  command: coverageWithCrashTolerance({ logName: "coverage_out" }),
  source: "scripts/_runner/ci-steps.ts",
  onFailure: [
    "ratchet failure: add tests to restore coverage — never lower thresholds (scripts/check-coverage.ts)",
    "post-test Bun crash (#1419): output should contain `PASS: All coverage thresholds met`",
    "log artefact: /tmp/coverage_out.txt (retry: coverage_out_retry.txt)",
  ],
};

// ===== Step lists per mode =====
//
// Pre-commit: fast feedback during `git commit`. Skips full test run
//   (already covered by pre-push / CI) but keeps the architectural
//   checks — they're cheap and catch the easy bugs early.
//
// Pre-push / CI: the gate that has to match what CI's `check` and `coverage`
//   jobs run. Test/coverage steps carry the #1004 / #1419 crash tolerance
//   the naive `bun test` / `check-coverage.ts` can't.
//
// Default (no flag): the developer-friendly path — parallel tests for
//   speed, `biome --write` for auto-fix, and the simpler coverage step
//   (no `--ci`, no crash retry). Use `--pre-push` or `--ci` when you want
//   exactly what CI runs.

const PRE_COMMIT: Step[] = [INSTALL, TYPECHECK, LINT_CHECK, RULES];
const COMPREHENSIVE: Step[] = [INSTALL, TYPECHECK, LINT, RULES, TEST_PARALLEL, TEST_CONTROL, COVERAGE];
const CI: Step[] = [INSTALL, TYPECHECK, LINT_CHECK, RULES, TEST_NON_DAEMON_CI, TEST_DAEMON_CI, COVERAGE_CI];

function selectSteps(): { steps: Step[]; label: string } {
  if (isPreCommit) return { steps: PRE_COMMIT, label: "pre-commit" };
  if (isCi) return { steps: CI, label: "ci" };
  if (isPrePush) return { steps: CI, label: "pre-push" };
  return { steps: COMPREHENSIVE, label: "default" };
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function parseRepeatableFlag(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1] as string);
  }
  return out;
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
    skip: parseRepeatableFlag(argv, "--skip"),
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
  bun run am-i-done [--pre-commit | --pre-push | --ci]
                    [--from N] [--only NAME] [--skip NAME...] [--verbose]

Flags:
  --pre-commit   fast subset suitable for the pre-commit hook (static only)
  --pre-push     comprehensive — matches CI exactly (the pre-push hook runs this)
  --ci           same as --pre-push; flag name CI itself uses
  --from N       resume from step N (number or name substring)
  --only N       run exactly one step (number or name substring)
  --skip NAME    skip a step by name (repeatable; substring match)
  --verbose      show captured step output even on success

--ci / --pre-push share one step list: typecheck → lint:check → rules sweep
→ non-daemon tests → daemon tests → coverage --ci. Tests and coverage carry
the #1004 (Bun crash-after-pass) and #1419 (coverage panic-on-teardown)
retry tolerance the naive \`bun test\` and \`check-coverage.ts\` lack. The
.git-hooks/pre-push hook and the CI workflow share this code path — one
definition of done (#2345).

The default (no flag) runs the developer-friendly comprehensive list:
parallel tests, \`biome --write\` for auto-fix, naive coverage step.

In a Claude / AI context (CLAUDECODE / AGENT / MCP_CLI_AI env var set),
step output is captured to build/am-i-done-<timestamp>.txt and only the
path is surfaced on failure. This is intentional — it prevents typecheck
or test failures from blowing out the orchestrator context budget.

All per-architecture invariants run through the doing-it-wrong rule
engine — see scripts/rules/*.rule.ts and scripts/ROADMAP.md.
`;

if (import.meta.main) {
  await main();
}
