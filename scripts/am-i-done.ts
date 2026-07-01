#!/usr/bin/env bun
/**
 * `am-i-done` — the unified oracle for "did I run every check?"
 *
 *   bun run am-i-done                       # full suite, developer-friendly
 *   bun run am-i-done --pre-commit          # fast static subset (pre-commit hook)
 *   bun run am-i-done --pre-push            # local gate: static + diff-aware tests (pre-push hook)
 *   bun run am-i-done --ci                  # exhaustive: full suite + coverage (used by ci.yml)
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
 * adapter — no second bun startup. Test/coverage steps run through factories
 * in `scripts/_runner/ci-steps.ts`: --ci runs the exhaustive suite + coverage
 * (Phase 5, #2345); --pre-push runs the diff-aware `bun test --changed` subset
 * for a ~90s local gate (#2393). Both carry the #1004 (Bun crash-after-pass)
 * and #1419 (coverage panic-on-teardown) retry tolerance the naive shell
 * commands lack.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bunTestWithCrashTolerance,
  changedTestsStep,
  coverageWithCrashTolerance,
  phasesTestWithCrashTolerance,
} from "./_runner/ci-steps";
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

const AGENT_GRID: Step = {
  name: "agent-grid",
  description: "agent-grid/versions.yaml schema validation",
  command: "bun scripts/validate-agent-grid.ts",
  onFailure: ["fix the validation errors reported above", "schema: agent-grid/versions-schema.ts"],
};

// Catches a committed .mcx.lock that has drifted from the phase/automation
// sources — including edits to a *transitive* import (e.g. review-fn.ts), which
// the entry-file-only hash used to miss (#2656). `phase check` hashes the full
// local-import closure and exits non-zero on any mismatch.
const PHASE_LOCK: Step = {
  name: "phase-lock",
  description: "verify .mcx.lock matches phase/automation source closure (#2656) — `mcx phase check`",
  command: "bun packages/command/src/main.ts phase check",
  onFailure: [
    "a phase/automation source changed without re-install — including a transitive import like *-fn.ts",
    "run `bun packages/command/src/main.ts phase install` and commit the updated .mcx.lock",
  ],
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

// lease: true on the heavy test phases caps the host-wide concurrent test-
// worker fan-out under N simultaneous gate runs across worktrees (#2690). CI
// steps stay unleased — each CI runner is its own host, so the per-container
// semaphore would never block and we don't want to perturb CI timing.
const TEST_PARALLEL: Step = {
  name: "test-parallel",
  description: "bun test --parallel (excluding packages/control — yoga-layout TDZ, #2362)",
  command: "bun test --parallel --no-orphans --path-ignore-patterns=packages/control/**",
  lease: true,
};

const TEST_CONTROL: Step = {
  name: "test-control",
  description: "bun test packages/control (sequential — yoga-layout TDZ workaround #2362)",
  command: "bun test --no-orphans packages/control",
  lease: true,
};

const COVERAGE: Step = {
  name: "coverage",
  description: "ratchet — never lower thresholds (see scripts/check-coverage.ts)",
  command: "bun scripts/check-coverage.ts",
  lease: true,
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

export const NON_DAEMON_TEST_PATHS = [
  "packages/acp",
  "packages/clone",
  "packages/codex",
  "packages/command",
  "packages/control",
  "packages/core",
  "packages/opencode",
  "packages/permissions",
  "scripts/",
  "agent-grid/",
];

export const DAEMON_TEST_PATHS = ["packages/daemon", "test/"];

const TEST_NON_DAEMON_CI: Step = {
  name: "test-non-daemon",
  description: "non-daemon tests (sequential; #1004 crash-after-pass + panic-retry tolerance)",
  command: bunTestWithCrashTolerance({
    paths: NON_DAEMON_TEST_PATHS,
    logName: "test_non_daemon",
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
  }),
  source: "scripts/_runner/ci-steps.ts",
  onFailure: [
    "real failure: see the captured output above",
    "post-test Bun crash (#1004): summary should show `0 fail` — would have been treated as pass",
    "log artefact: /tmp/test_daemon.txt (retry: test_daemon_retry.txt)",
  ],
};

const TEST_PHASES_CI: Step = {
  name: "test-phases",
  description:
    "phase fn-specs (.claude/phases/*-fn.spec.ts) — co-located specs excluded from bunfig pathIgnorePatterns (#2648)",
  command: phasesTestWithCrashTolerance({
    phasesDir: resolve(REPO_ROOT, ".claude/phases"),
    logName: "test_phases",
  }),
  source: "scripts/_runner/ci-steps.ts",
  onFailure: [
    "run `bun run test:phases` locally to reproduce",
    "specs live in .claude/phases/*-fn.spec.ts — co-located next to each phase module",
    "log artefact: /tmp/test_phases.txt",
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

const TEST_CHANGED: Step = {
  name: "test-changed",
  description:
    "diff-aware tests — only files affected by the diff (bun test --changed; parallel, control sequential #2362)",
  command: changedTestsStep({ logName: "test_changed" }),
  source: "scripts/_runner/ci-steps.ts",
  lease: true,
  onFailure: [
    "real failure: see the captured output above",
    "this runs only tests in your diff's blast radius — CI (`--ci`) runs the full suite + coverage",
    "to reproduce a CI-only failure locally: bun run am-i-done --ci",
    "log artefact: /tmp/test_changed.txt (control pass: /tmp/test_changed_control.txt)",
    "if you changed a worker or alias file and 0 tests ran (--pass-with-no-tests fired silently), bun's module graph cannot trace dynamic imports or path-string worker loads — run `bun run am-i-done --ci` before pushing (#2396)",
  ],
};

const STALE_TODOS_CI: Step = {
  name: "stale-todos",
  description: "dotw-todo stale-issue check — shells out to gh per unique issue number (CI only; fixes #2533)",
  command: "bun scripts/check-stale-todos.ts",
  onFailure: [
    "a dotw-todo comment references a closed GitHub issue",
    "fix: remove the underlying violation (and its dotw-todo suppression)",
    "or reopen / file a successor issue and update the #NNN reference",
  ],
};

// ===== Step lists per mode =====
//
// Pre-commit: fast feedback during `git commit`. Skips tests entirely
//   (covered by pre-push / CI) but keeps the architectural checks —
//   they're cheap and catch the easy bugs early.
//
// Pre-push: the local gate. Same *pipeline* as CI (typecheck → lint → rules
//   → tests) but scoped to the diff: `bun test --changed` runs only the
//   files in the change's blast radius, and coverage is omitted (it's a
//   whole-codebase ratchet — meaningless to scope, so it lives only in CI).
//   This keeps a real push under a ~90s human/agent attention budget while
//   CI owns the long tail. "Local covers 99%, CI covers the rest" (#2393).
//
// CI: the exhaustive gate CI's `check` and `coverage` jobs run — full
//   non-daemon + daemon suites and the coverage ratchet, all carrying the
//   #1004 / #1419 crash tolerance the naive `bun test` can't.
//
// Default (no flag): the developer-friendly path — parallel tests for
//   speed, `biome --write` for auto-fix, and the simpler coverage step.

// phase-lock is deliberately omitted from PRE_COMMIT / PRE_PUSH: `mcx phase
// check` resolves its root to the *main* checkout from a linked worktree
// (phase.ts → findGitRoot, #2673), so wiring it into the local hooks both
// false-positive-blocks every clean worktree commit/push and false-negatives
// the worktree's own lock drift (#2737). It stays in CI / COMPREHENSIVE, which
// run against a real checkout where the root is the repo root and the check is
// sound. Re-add to the local hooks once #2737 makes the resolver worktree-aware.
export const PRE_COMMIT: Step[] = [INSTALL, TYPECHECK, LINT_CHECK, RULES, AGENT_GRID];
export const PRE_PUSH: Step[] = [INSTALL, TYPECHECK, LINT_CHECK, RULES, AGENT_GRID, TEST_CHANGED];
export const COMPREHENSIVE: Step[] = [
  INSTALL,
  TYPECHECK,
  LINT,
  RULES,
  AGENT_GRID,
  PHASE_LOCK,
  TEST_PARALLEL,
  TEST_CONTROL,
  TEST_PHASES_CI,
  COVERAGE,
];
export const CI: Step[] = [
  INSTALL,
  TYPECHECK,
  LINT_CHECK,
  RULES,
  AGENT_GRID,
  PHASE_LOCK,
  STALE_TODOS_CI,
  TEST_NON_DAEMON_CI,
  TEST_DAEMON_CI,
  TEST_PHASES_CI,
  COVERAGE_CI,
];

function selectSteps(): { steps: Step[]; label: string } {
  if (isPreCommit) return { steps: PRE_COMMIT, label: "pre-commit" };
  if (isCi) return { steps: CI, label: "ci" };
  if (isPrePush) return { steps: PRE_PUSH, label: "pre-push" };
  return { steps: COMPREHENSIVE, label: "default" };
}

export function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function parseRepeatableFlag(argv: string[], flag: string): string[] {
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
  --pre-push     local gate — static checks + diff-aware tests (~90s budget)
  --ci           exhaustive — full suite + coverage, exactly what CI runs
  --from N       resume from step N (number or name substring)
  --only N       run exactly one step (number or name substring)
  --skip NAME    skip a step by name (repeatable; substring match)
  --verbose      show captured step output even on success

--pre-push is the local gate the .git-hooks/pre-push hook runs: typecheck →
lint:check → rules sweep → \`bun test --changed\` (only files in the diff's
blast radius; parallel, control sequential for #2362). It deliberately omits
coverage — the ratchet is a whole-codebase check that belongs in CI. The goal
is a real push under a ~90s attention budget; CI owns the long tail (#2393).

--ci is the exhaustive gate CI's \`check\` and \`coverage\` jobs run: full
non-daemon → daemon suites → coverage --ci, all carrying the #1004 (Bun
crash-after-pass) and #1419 (coverage panic-on-teardown) retry tolerance the
naive \`bun test\` / \`check-coverage.ts\` lack. Same code path here and in the
workflow — one definition of done (#2345).

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
