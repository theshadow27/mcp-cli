#!/usr/bin/env bun
/**
 * Coverage threshold enforcement + per-file test timing.
 *
 * Parses `bun test --coverage` text output and exits non-zero if:
 *   1. Overall coverage drops below global thresholds (ratchet)
 *   2. Any individual file drops below per-file minimum (unless excluded)
 *   3. Any single test file exceeds the per-file time budget
 *
 * After the coverage run, profiles each test file individually (in parallel)
 * to collect per-file timing and reports the top 10 slowest.
 *
 * Usage:  bun scripts/check-coverage.ts
 *
 * Bump thresholds up as coverage improves; never lower them.
 */

// --- Configuration ---

/** Global minimum coverage (overall "All files" row) */
const GLOBAL_THRESHOLDS = {
  functions: 72,
  lines: 69,
};

/** Per-file test time budget in milliseconds — no single file should exceed this */
const PER_FILE_TIME_BUDGET_MS = 5_000;

/** Number of test files to profile concurrently — kept low to avoid FS/network contention inflating times */
const PROFILE_CONCURRENCY = 4;

/**
 * Test files excluded from the per-file time budget.
 * These are intentionally slow integration/stress tests that spawn real daemons.
 */
const TIMING_EXCLUSIONS: Record<string, string> = {
  "test/daemon-integration.spec.ts": "Full daemon lifecycle integration tests",
  "test/stress.spec.ts": "Stress tests spawning real CLI processes",
};

/**
 * Maximum allowed production log noise lines during test runs.
 * Matches daemon log prefixes ([mcpd], [_claude], [_aliases]) and
 * production signals (MCPD_READY). Ratchet this down toward zero.
 */
const NOISE_THRESHOLD = 22;

/** Per-file minimum coverage — every file must meet this unless excluded */
const PER_FILE_MIN_LINES = 80;

/**
 * Files excluded from per-file enforcement, with reasons.
 * Paths are matched as suffixes (e.g. "foo.ts" matches "packages/.../foo.ts").
 */
const EXCLUSIONS: Record<string, string> = {
  // TUI components — require terminal/React rendering to test meaningfully
  "control/src/components/auth-banner.tsx": "TUI component, needs integration test",
  "control/src/components/header.tsx": "TUI component, needs integration test",
  "control/src/components/server-detail.tsx": "TUI component, needs integration test",
  "control/src/hooks/use-keyboard.ts": "TUI hook, needs integration test",
  "control/src/components/claude-session-detail.tsx": "TUI component, needs integration test",
  "control/src/components/claude-session-list.tsx": "TUI component, needs integration test",
  "control/src/components/tab-bar.tsx": "TUI component, needs integration test",
  "control/src/hooks/use-logs.ts": "TUI hook, needs integration test",
  "control/src/components/utils.spec.ts": "Test file (not source)",

  // Integration-heavy paths — require running daemon to exercise
  "core/src/ipc-client.ts": "IPC transport requires running daemon (#51)",
  "command/src/daemon-lifecycle.ts": "Daemon startup/lifecycle requires integration test (#51)",
  "core/src/cli-config.ts": "Reads ~/.claude.json, integration-only",

  // Command dispatch — CLI entry point, tested via integration
  "command/src/alias-runner.ts": "Virtual module + import(), integration-only (#52)",
  "command/src/output.ts": "Formatting output, low-risk — tracked in #47",

  // Commands below PER_FILE_MIN — tracked in open issues
  "command/src/commands/alias.ts": "5% coverage, tracked in #47",
  "command/src/commands/logs.ts": "19% coverage, tracked in #47",
  "command/src/commands/install.ts": "41% coverage, needs work",
  "command/src/commands/run.ts": "55% coverage, needs work",
  "command/src/commands/remove.ts": "61% coverage, needs work",
  "command/src/commands/config-file.ts": "61% coverage, needs work",
  "command/src/commands/add.ts": "65% coverage, needs work",
  "command/src/commands/completions.ts": "73% coverage, close to threshold",

  // Daemon internals — connection lifecycle requires integration
  "daemon/src/server-pool.ts": "51% coverage, connection lifecycle (#45/#51)",
  "daemon/src/ipc-server.ts": "59% coverage, handler logic (#46)",
  "daemon/src/config/watcher.ts": "47% coverage, FS watcher loop (#48)",

  // CI scripts — git-dependent, tested via pure-function unit tests + CI integration
  "scripts/release.ts": "CI-only release script, git-dependent async functions untestable in isolation",

  // Test harness — not production code
  "test/harness.ts": "Test infrastructure, not source",
};

// --- Main ---

import { Glob } from "bun";
import { logTestRun } from "./test-failure-log";
import { detectTestNoise } from "./test-noise";

/** Discover all test files in the project */
async function findTestFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Glob("**/*.spec.{ts,tsx}").scan({ cwd: ".", onlyFiles: true })) {
    files.push(path);
  }
  return files.sort();
}

/** Run a single test file and return its wall-clock duration in ms */
async function timeTestFile(file: string): Promise<{ file: string; ms: number }> {
  const start = performance.now();
  const p = Bun.spawn(["bun", "test", file, "--timeout", "30000"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
  return { file, ms: Math.round(performance.now() - start) };
}

/** Profile all test files with bounded concurrency, return sorted results */
async function profileTestFiles(files: string[], concurrency: number): Promise<{ file: string; ms: number }[]> {
  const results: { file: string; ms: number }[] = [];
  const queue = [...files];

  async function worker(): Promise<void> {
    let file = queue.shift();
    while (file) {
      results.push(await timeTestFile(file));
      file = queue.shift();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  return results.sort((a, b) => b.ms - a.ms);
}

// Ensure deps are installed (fast no-op when already present)
const installProc = Bun.spawn(["bun", "install"], { stdout: "ignore", stderr: "ignore" });
await installProc.exited;

const testStart = Date.now();
const proc = Bun.spawn(["bun", "test", "--coverage"], {
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exitCode = await proc.exited;
const testDuration = Date.now() - testStart;

// Print original output so user sees test results + coverage table
process.stdout.write(stdout);
process.stderr.write(stderr);

if (exitCode !== 0) {
  try {
    logTestRun(stdout + stderr, exitCode, testDuration);
  } catch {
    // Logging must never mask the actual test failure
  }
  process.exit(exitCode);
}

const output = stdout + stderr;

// --- Parse global summary ---

const allFilesMatch = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);

if (!allFilesMatch) {
  console.error("Could not parse coverage summary from test output.");
  console.error('Ensure bunfig.toml has coverage = true and look for "All files" row.');
  process.exit(1);
}

const globalFuncs = Number.parseFloat(allFilesMatch[1]);
const globalLines = Number.parseFloat(allFilesMatch[2]);

// --- Parse per-file rows ---
// Format: " packages/core/src/config.ts  |  100.00 |  100.00 | "
const fileRowRegex = /^\s*([\w/.@-]+\.(?:ts|tsx))\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/gm;
const failures: { file: string; lines: number }[] = [];

for (const match of output.matchAll(fileRowRegex)) {
  const file = match[1];
  const lines = Number.parseFloat(match[3]);

  if (lines >= PER_FILE_MIN_LINES) continue;

  // Check exclusions (suffix match)
  const excluded = Object.keys(EXCLUSIONS).some((pattern) => file.endsWith(pattern));
  if (excluded) continue;

  failures.push({ file, lines });
}

// --- Check test output noise ---

const noiseLines = detectTestNoise(output);

// --- Report ---

console.log("\n--- Coverage Report ---");
console.log(`Global:    ${globalFuncs}% functions, ${globalLines}% lines`);
console.log(`Threshold: ${GLOBAL_THRESHOLDS.functions}% functions, ${GLOBAL_THRESHOLDS.lines}% lines`);
console.log(`Per-file:  ${PER_FILE_MIN_LINES}% lines minimum (${Object.keys(EXCLUSIONS).length} exclusions)`);

let failed = false;

if (globalFuncs < GLOBAL_THRESHOLDS.functions) {
  console.error(`\nFAIL: Function coverage ${globalFuncs}% is below global threshold ${GLOBAL_THRESHOLDS.functions}%`);
  failed = true;
}

if (globalLines < GLOBAL_THRESHOLDS.lines) {
  console.error(`\nFAIL: Line coverage ${globalLines}% is below global threshold ${GLOBAL_THRESHOLDS.lines}%`);
  failed = true;
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} file(s) below ${PER_FILE_MIN_LINES}% line coverage:`);
  for (const { file, lines } of failures.sort((a, b) => a.lines - b.lines)) {
    console.error(`  ${lines.toFixed(1)}%  ${file}`);
  }
  console.error("\nEither add tests or add an exclusion with a reason in scripts/check-coverage.ts");
  failed = true;
}

console.log(`\nTest noise: ${noiseLines.length} production log line(s) detected (threshold: ${NOISE_THRESHOLD})`);
if (noiseLines.length > NOISE_THRESHOLD) {
  console.error(`\nFAIL: Test output noise ${noiseLines.length} exceeds threshold ${NOISE_THRESHOLD}`);
  console.error("Production log output leaked into test run. Inject silentLogger to suppress:");
  for (const line of noiseLines.slice(0, 20)) {
    console.error(`  ${line}`);
  }
  if (noiseLines.length > 20) {
    console.error(`  ... and ${noiseLines.length - 20} more`);
  }
  failed = true;
}

// --- Per-file test timing ---

console.log("\n--- Test Timing Profile ---");
const testFiles = await findTestFiles();
const profileStart = performance.now();
const timings = await profileTestFiles(testFiles, PROFILE_CONCURRENCY);
const profileDuration = Math.round(performance.now() - profileStart);
const sequentialSum = timings.reduce((sum, t) => sum + t.ms, 0);

console.log(
  `Profiled ${timings.length} test files in ${(profileDuration / 1000).toFixed(1)}s (sequential sum: ${(sequentialSum / 1000).toFixed(1)}s)`,
);
console.log(
  `\nTop 10 slowest test files (budget: ${PER_FILE_TIME_BUDGET_MS}ms, ${Object.keys(TIMING_EXCLUSIONS).length} excluded):`,
);
for (const { file, ms } of timings.slice(0, 10)) {
  const excluded = Object.keys(TIMING_EXCLUSIONS).some((pattern) => file.endsWith(pattern));
  const marker = ms > PER_FILE_TIME_BUDGET_MS ? (excluded ? " (excluded)" : " ← OVER BUDGET") : "";
  console.log(`  ${String(ms).padStart(6)}ms  ${file}${marker}`);
}

const overBudget = timings.filter((t) => {
  if (t.ms <= PER_FILE_TIME_BUDGET_MS) return false;
  const excluded = Object.keys(TIMING_EXCLUSIONS).some((pattern) => t.file.endsWith(pattern));
  return !excluded;
});
if (overBudget.length > 0) {
  console.error(`\nFAIL: ${overBudget.length} test file(s) exceed ${PER_FILE_TIME_BUDGET_MS}ms per-file budget:`);
  for (const { file, ms } of overBudget) {
    console.error(`  ${ms}ms  ${file}`);
  }
  console.error("\nExtract pure logic into unit tests or split the file. See CLAUDE.md test budget rule.");
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("\nPASS: All coverage thresholds met.\n");
