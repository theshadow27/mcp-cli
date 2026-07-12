#!/usr/bin/env bun
/**
 * Coverage threshold enforcement + hash-based test timing cache.
 *
 * Parses `bun test --coverage` text output and exits non-zero if:
 *   1. Overall coverage drops below global thresholds (ratchet)
 *   2. Any individual file drops below per-file minimum (unless excluded)
 *
 * After the coverage run, profiles test files whose content hash has changed
 * since the last run (stored in test-timings.json, gitignored).  Budget
 * violations are reported as warnings — they never block commits.
 *
 * Note: the hash covers only the test file content, not transitive imports.
 * Use --full to force re-timing all files after production code changes.
 *
 * Usage:  bun scripts/check-coverage.ts          # incremental timing
 *         bun scripts/check-coverage.ts --full    # re-time all files
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

/**
 * Aggregate test suite time budget in milliseconds.
 * Sum of all non-excluded test file times (sequential sum) should stay below this.
 * Uses sequential sum (not parallel wall time) for reproducibility across machines.
 * Ratchet this down as optimizations land. Warns but never blocks commits.
 *
 * Parallel wall time on 16-core Apple Silicon (post wsPort + --parallel fixes):
 *   ~16s for the full suite. The previous "~100s parallel wall is the floor"
 *   conclusion was wrong — it didn't account for the 5s WS-port retry tax that
 *   daemon-integration.spec.ts paid on every spawn. The earlier "infeasible
 *   <25s" comment in this file was based on that bug. See PR description.
 */
const AGGREGATE_TIME_BUDGET_MS = 39_000;

/** Number of test files to profile concurrently — scales with available CPUs */
const PROFILE_CONCURRENCY = Math.max(4, Math.min(navigator.hardwareConcurrency ?? 4, 32));

/**
 * Test files excluded from the per-file time budget.
 * These are intentionally slow integration/stress tests that spawn real daemons.
 */
const TIMING_EXCLUSIONS: Record<string, string> = {
  "test/daemon-integration.spec.ts":
    "Full daemon lifecycle integration tests (~12s; P1 idle-timeout burns 4s alone; P5b/P5c share daemons post #2014)",
  "test/stress.spec.ts": "Stress tests spawning real CLI processes",
  "test/transport-errors.spec.ts": "Live daemon transport error integration tests",
  "packages/daemon/src/index.spec.ts": "13 in-process daemon instances for startup/shutdown/idle/reload",
  "packages/daemon/src/config/watcher.spec.ts": "FS polling integration tests with 8s timeouts",
  "packages/core/src/alias-bundle-tsc.spec.ts": "bunx tsc subprocess spawning per test (~3-4s each)",
  "packages/core/src/git-core-bare-repro.spec.ts": "Subprocess-heavy git race reproduction tests (~7s)",
  "test/cli-orchestration.spec.ts": "CLI→daemon orchestration smoke tests with real daemon + mock sessions",
};

/**
 * Maximum allowed production log noise lines during test runs.
 * Matches daemon log prefixes ([mcpd], [_claude], [_aliases]) and
 * production signals (MCPD_READY). Ratchet this down toward zero.
 *
 * Current sources (1 total):
 *    1 × [mcpd] test message — daemon-log.spec.ts intentionally tests capture
 */
const NOISE_THRESHOLD = 1;

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
  "control/src/components/agent-session-detail.tsx": "TUI component, needs integration test",
  "control/src/components/agent-session-list.tsx": "TUI component, needs integration test",
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

  // CI scripts — git-dependent, tested via pure-function unit tests + CI integration
  "scripts/release.ts": "CI-only release script, git-dependent async functions untestable in isolation",
  "scripts/doing-it-wrong.ts":
    "Rule-engine CLI entry; runRules() is covered by doing-it-wrong.spec.ts — residual is main()/process.exit/import.meta.main plumbing, untestable in-process",
  // Test harness — not production code
  "test/harness.ts": "Test infrastructure, not source",
};

// --- Main ---

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { coveragePathInDiff, resolveChangedSourceFiles } from "./coverage-diff";
import { checkSpecCountFloor, countExpectedSpecFiles, formatExclusionList } from "./coverage-report";
// staged-files still available for --ci mode if needed in the future
import { logTestRun } from "./test-failure-log";
import { detectTestNoise } from "./test-noise";
import { findChangedFiles, findTestFiles, loadTimings, pruneStaleEntries, saveTimings } from "./test-timings";

/** Run a single test file and return its wall-clock duration in ms */
async function timeTestFile(file: string): Promise<{ file: string; ms: number }> {
  const start = performance.now();
  const p = Bun.spawn(["bun", "test", "--no-orphans", file, "--timeout", "30000"], {
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

// --- Split test runs to avoid Bun segfault (#965) ---
// Running all tests (especially daemon worker-thread tests) in a single
// `bun test --coverage` process triggers a non-deterministic segfault in
// Bun v1.3.11.  Splitting daemon tests into a separate invocation avoids it.
//
// Pre-commit (default): skips run-2 entirely — daemon tests take ~136s and
// segfault on macOS (#957). CI is the gate for daemon tests. See #1125.
// CI (--ci flag): runs both phases with segfault retry at the workflow level.

/** Discover non-daemon package test directories */
const packageDirs = readdirSync(resolve(import.meta.dir, "../packages"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "daemon")
  .map((d) => `packages/${d.name}/src`);

/**
 * Allowlist: only these top-level test files run in run-1 (non-daemon process).
 * Everything else in test/ defaults to run-2 (isolated daemon process).
 * This is intentionally inverted — new test files land in run-2 (safe default)
 * rather than run-1 where a daemon-spawning test could hang the coverage pass.
 *
 * Daemon test files are also listed in TIMING_EXCLUSIONS above for time budget
 * purposes. If you move a file into this allowlist, consider whether it still
 * needs a TIMING_EXCLUSIONS entry.
 */
const RUN1_TEST_FILES = new Set(["test/integration.spec.ts"]);

/**
 * Pure-unit daemon test files: spec files from packages/daemon/src that have
 * NO daemon connection dependencies and can safely run in run-1.  Add files
 * here when their coverage would otherwise be excluded due to run-2 being
 * skipped pre-commit.  Never add files that spawn Workers or connect to the
 * daemon socket — those belong in run-2.
 */
const RUN1_DAEMON_UNIT_TESTS = ["packages/daemon/src/claude-session/permission-router.spec.ts"];

// Validate that all allowlist entries exist on disk — catches renames/deletions
for (const f of [...RUN1_TEST_FILES, ...RUN1_DAEMON_UNIT_TESTS]) {
  if (!existsSync(resolve(import.meta.dir, "..", f))) {
    throw new Error(`Allowlist entry does not exist: ${f}`);
  }
}

/** Non-daemon test files from test/ — only allowlisted files go in run-1 */
const topLevelTestFiles = readdirSync(resolve(import.meta.dir, "../test"))
  .filter((f) => f.endsWith(".spec.ts") && RUN1_TEST_FILES.has(`test/${f}`))
  .map((f) => `test/${f}`);

const nonDaemonPaths = [
  ...packageDirs,
  // agent-grid is a workspace sibling of packages/ (see root package.json
  // "workspaces"), so the packages/* enumeration above misses it entirely.
  // Without this line its specs never run in the coverage gate and its files
  // are never ratcheted — which is how isolation.ts shipped unmeasured.
  // Daemon-free and fast (~0.5s); safe in run-1. (#2586 follow-up)
  "agent-grid/src",
  "scripts/rules",
  "scripts/_runner",
  ...topLevelTestFiles,
  ...RUN1_DAEMON_UNIT_TESTS,
];

const testStart = Date.now();

// --junit-outfile: structured test-failure summary for ci-steps.ts crash-after-pass
// detection (#2401). When provided, junit XML is written for each inner bun test
// run, then aggregated into a single JSON { failures: N } at the specified path.
const junitOutfile = process.argv.find((a) => a.startsWith("--junit-outfile="))?.slice("--junit-outfile=".length);
const junit1Path = junitOutfile ? `/tmp/coverage-junit-run1-${Date.now()}.xml` : undefined;

// Run 1: non-daemon tests with --coverage (produces the coverage table we parse).
// NOTE: --parallel cannot be combined with --coverage — Bun's parallel workers
// each emit their own coverage table and `bun test` reports only the worker
// that finishes last, attributing 0 lines/funcs to files exercised in other
// workers. That made global line coverage drop from 93.94% to 87.49% with
// 35 files falsely flagged below the 80% per-file floor. The dev `bun test`
// command uses --parallel for speed (no --coverage there), and this script
// stays sequential for accurate coverage aggregation.
const run1Args = ["bun", "test", "--no-orphans", "--coverage", ...nonDaemonPaths];
if (junit1Path) run1Args.push("--reporter", "junit", `--reporter-outfile=${junit1Path}`);
const proc1 = Bun.spawn(run1Args, {
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout1, stderr1] = await Promise.all([new Response(proc1.stdout).text(), new Response(proc1.stderr).text()]);
const exitCode1 = await proc1.exited;

// Run 2: daemon tests in isolated process (avoids segfault)
// Includes packages/daemon/src AND all non-allowlisted test files from test/
// Skip run-2 when staged files don't touch daemon-related paths (#1085)
const ciMode = process.argv.includes("--ci");
const forceRun2 = process.argv.includes("--force-run2") || ciMode;
// Pre-commit: always skip run-2 (daemon tests take ~136s + segfault). CI is the gate. (#1125)
const skipRun2 = !forceRun2;

let stdout2 = "";
let stderr2 = "";
let exitCode2 = 0;
// Declared here so the junit aggregation block below can read it regardless of
// whether skipRun2 is true — block-scoped const inside the else {} would not be
// visible at the aggregation site.
let junit2Path: string | undefined = undefined;

if (skipRun2) {
  console.log("Skipping run-2 (daemon tests) — pre-commit fast path (#1125). Use --ci or --force-run2 for full suite.");
} else {
  const daemonTestFiles = readdirSync(resolve(import.meta.dir, "../test"))
    .filter((f) => f.endsWith(".spec.ts") && !RUN1_TEST_FILES.has(`test/${f}`))
    .map((f) => `test/${f}`);
  // Run 2: daemon tests. --parallel is safe here because no --coverage flag,
  // and ws-server's port-retry tax has been reduced (see ws-server.ts).
  junit2Path = junitOutfile ? `/tmp/coverage-junit-run2-${Date.now()}.xml` : undefined;
  const run2Args = [
    "bun",
    "test",
    "--no-orphans",
    "--parallel",
    "--timeout",
    "60000",
    "packages/daemon/src",
    ...daemonTestFiles,
  ];
  if (junit2Path) run2Args.push("--reporter", "junit", `--reporter-outfile=${junit2Path}`);
  const proc2 = Bun.spawn(run2Args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Process-level deadline: if run-2 hangs (e.g. daemon teardown bug), kill it
  // rather than blocking pre-commit indefinitely. 300s is generous enough for
  // the full daemon + integration test suite while still catching real hangs.
  // See #1078 — the previous 120s deadline was too aggressive and consistently
  // killed daemon tests that were still making progress.
  const RUN2_DEADLINE_MS = 300_000;
  const run2Deadline = setTimeout(() => {
    console.error(`\nERROR: run-2 (daemon tests) exceeded ${RUN2_DEADLINE_MS / 1000}s deadline — killing process`);
    proc2.kill();
  }, RUN2_DEADLINE_MS);

  [stdout2, stderr2] = await Promise.all([new Response(proc2.stdout).text(), new Response(proc2.stderr).text()]);
  exitCode2 = await proc2.exited;
  clearTimeout(run2Deadline);
}

const testDuration = Date.now() - testStart;

// Combine output from both runs
const stdout = stdout1 + stdout2;
const stderr = stderr1 + stderr2;

// Print original output so user sees test results + coverage table.
// Use awaited Bun.write so the kernel pipe drains before any later
// process.exit() — process.stderr.write() returns immediately and the
// unflushed tail is discarded on _exit(2), truncating diagnostic output
// at the kernel pipe boundary (~64–74KB on macOS/Linux). That's how a
// single failing test silently wiped the rest of the coverage report
// in CI. See #1870.
await Bun.write(Bun.stdout, stdout);
await Bun.write(Bun.stderr, stderr);

// Write aggregated junit summary for ci-steps.ts crash-after-pass detection (#2401).
// Counts failures from each run's junit XML and writes { failures: N } to --junit-outfile.
// Written before the exit so ci-steps.ts can read it regardless of whether this
// process exits cleanly or with an error code.
if (junitOutfile) {
  try {
    // Returns null when the junit file is absent or unparseable — mirrors
    // parseJunitFailures() in ci-steps.ts. A missing file means the inner bun
    // run crashed before flushing the reporter; returning 0 would fabricate a
    // false "clean" signal. The outer classifyCoverage falls back to the durable
    // stdout signal instead (#2401 hybrid).
    const readJunitFailures = (xmlPath: string | undefined): number | null => {
      if (!xmlPath) return null;
      try {
        const xml = readFileSync(xmlPath, "utf8");
        const m = xml.match(/failures="(\d+)"/);
        return m ? Number.parseInt(m[1], 10) : null;
      } catch {
        return null;
      }
    };
    const f1 = readJunitFailures(junit1Path);
    // run-2 was skipped → no tests ran in that phase, treat as 0 failures.
    const f2 = skipRun2 ? 0 : readJunitFailures(junit2Path);
    // Any missing junit file → write null so the outer classifier uses the
    // durable stdout fallback instead of trusting a fabricated zero.
    const totalFailures = f1 === null || f2 === null ? null : f1 + f2;
    writeFileSync(junitOutfile, JSON.stringify({ failures: totalFailures }));
  } catch {
    /* best-effort — crash tolerance is non-essential */
  }
}

// Fail if either run failed
const exitCode = exitCode1 !== 0 ? exitCode1 : exitCode2;
if (exitCode !== 0) {
  try {
    logTestRun(stdout + stderr, exitCode, testDuration);
  } catch {
    // Logging must never mask the actual test failure
  }
  process.exit(exitCode);
}

const output = stdout + stderr;

// --- Parse global summary from run 1 (non-daemon has the larger surface) ---

const coverageRun1 = stdout1 + stderr1;
const allFilesMatch = coverageRun1.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);

if (!allFilesMatch) {
  console.error("Could not parse coverage summary from test output.");
  console.error('Ensure bunfig.toml has coverage = true and look for "All files" row.');
  process.exit(1);
}

const globalFuncs = Number.parseFloat(allFilesMatch[1]);
const globalLines = Number.parseFloat(allFilesMatch[2]);

// --- Parse per-file rows from BOTH runs, taking max coverage per file ---
// A file may appear in both runs (e.g. daemon files imported transitively by
// non-daemon tests). We take the best coverage from either run so that daemon
// files tested in run 2 get proper credit.
// Format: " packages/core/src/config.ts  |  100.00 |  100.00 | "
const fileRowRegex = /^\s*([\w/.@-]+\.(?:ts|tsx))\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/gm;

const bestCoverage = new Map<string, { funcs: number; lines: number }>();
for (const source of [coverageRun1, stdout2 + stderr2]) {
  for (const match of source.matchAll(fileRowRegex)) {
    const file = match[1];
    const funcs = Number.parseFloat(match[2]);
    const lines = Number.parseFloat(match[3]);
    const prev = bestCoverage.get(file);
    if (!prev || lines > prev.lines) {
      bestCoverage.set(file, { funcs, lines });
    }
  }
}

// --- Diff-scoping: only fail on files the current branch touches (#2495) ---
// On a feature branch, pre-existing gaps in untouched files warn but don't fail.
// On main (or when git state is indeterminate), full enforcement applies.
const changedFiles = resolveChangedSourceFiles();
const isDiffScoped = changedFiles !== null;

function isFileInDiff(coveragePath: string): boolean {
  return coveragePathInDiff(coveragePath, changedFiles);
}

const failures: { file: string; lines: number }[] = [];
const preExistingGaps: { file: string; lines: number }[] = [];

for (const [file, { lines }] of bestCoverage) {
  if (lines >= PER_FILE_MIN_LINES) continue;

  const excluded = Object.keys(EXCLUSIONS).some((pattern) => file.endsWith(pattern));
  if (excluded) continue;

  if (isDiffScoped && !isFileInDiff(file)) {
    preExistingGaps.push({ file, lines });
  } else {
    failures.push({ file, lines });
  }
}

// --- Check test output noise ---

const noiseLines = detectTestNoise(output);

// --- Report ---

console.log("\n--- Coverage Report ---");
console.log(`Global:    ${globalFuncs}% functions, ${globalLines}% lines`);
console.log(`Threshold: ${GLOBAL_THRESHOLDS.functions}% functions, ${GLOBAL_THRESHOLDS.lines}% lines`);
console.log(
  `Per-file:  ${PER_FILE_MIN_LINES}% lines minimum (${Object.keys(EXCLUSIONS).length} exclusions${isDiffScoped ? `, diff-scoped to ${changedFiles.size} changed file(s)` : ""})`,
);

let failed = false;

if (globalFuncs < GLOBAL_THRESHOLDS.functions) {
  console.error(`\nFAIL: Function coverage ${globalFuncs}% is below global threshold ${GLOBAL_THRESHOLDS.functions}%`);
  failed = true;
}

if (globalLines < GLOBAL_THRESHOLDS.lines) {
  console.error(`\nFAIL: Line coverage ${globalLines}% is below global threshold ${GLOBAL_THRESHOLDS.lines}%`);
  failed = true;
}

// --- Spec-count sanity floor (#2815) ---
// Guard against a silent shrink of the coverage surface: if run-1 discovers
// fewer spec files than exist on disk under its run paths, the per-file floor
// above was recomputed against fewer files and would still print PASS. Fail
// closed. Checked against run-1 output only (the coverage table we parse);
// run-2 daemon specs have their own discovery gate in ci-steps.ts (#2719).
const expectedSpecFiles = countExpectedSpecFiles(nonDaemonPaths, resolve(import.meta.dir, ".."));
const specFloor = checkSpecCountFloor(coverageRun1, expectedSpecFiles);
console.log(`Spec floor: ${specFloor.discovered ?? "?"} discovered / ${specFloor.expected} expected spec file(s)`);
if (!specFloor.ok) {
  console.error(`\nFAIL: ${specFloor.reason}`);
  failed = true;
}

if (preExistingGaps.length > 0) {
  console.warn(
    `\nWARN: ${preExistingGaps.length} file(s) below ${PER_FILE_MIN_LINES}% on main (not in diff — skipped):`,
  );
  for (const { file, lines } of preExistingGaps.sort((a, b) => a.lines - b.lines)) {
    console.warn(`  ${lines.toFixed(1)}%  ${file}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} file(s) below ${PER_FILE_MIN_LINES}% line coverage:`);
  for (const { file, lines } of failures.sort((a, b) => a.lines - b.lines)) {
    console.error(`  ${lines.toFixed(1)}%  ${file}`);
  }
  console.error("\nEither add tests or add an exclusion with a reason in scripts/check-coverage.ts");
  // Itemize the active exclusions so a file masked at the .endsWith() check is
  // visible here rather than silently skipped (#2815). If the failing file is
  // already covered by a broader suffix pattern, it shows up in this list.
  console.error(`\n${Object.keys(EXCLUSIONS).length} active per-file exclusion(s):`);
  for (const line of formatExclusionList(EXCLUSIONS)) {
    console.error(line);
  }
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

// --- Per-file test timing (hash-based cache — see #812) ---
// Only re-times test files whose content has changed since the last run.
// Budget violations warn to stderr but NEVER block commits.

const fullMode = process.argv.includes("--full");
const runProfiling = fullMode || ciMode;
const TIMING_CACHE_PATH = resolve(import.meta.dir, "../test-timings.json");

if (!runProfiling) {
  // Pre-commit: skip profiling entirely — it re-runs tests individually (#1125)
  console.log("\n--- Test Timing Profile ---");
  console.log("Skipped (pre-commit fast path). Use --full or --ci to profile.");
} else {
  const cache = loadTimings(TIMING_CACHE_PATH);
  const testFiles = await findTestFiles();

  // Prune entries for deleted test files
  const currentFileSet = new Set(testFiles);
  const pruned = pruneStaleEntries(cache, currentFileSet);

  const { changed, hashes } = await findChangedFiles(testFiles, cache);
  const filesToTime = fullMode ? testFiles : changed;

  if (filesToTime.length > 0) {
    console.log(`\n--- Test Timing Profile (${fullMode ? "full" : "incremental"}) ---`);
    console.log(`${filesToTime.length} of ${testFiles.length} test file(s) to profile`);
    if (pruned > 0) console.log(`Pruned ${pruned} stale cache entries`);

    const profileStart = performance.now();
    const timings = await profileTestFiles(filesToTime, PROFILE_CONCURRENCY);
    const profileDuration = Math.round(performance.now() - profileStart);
    const sequentialSum = timings.reduce((sum, t) => sum + t.ms, 0);

    console.log(
      `Profiled ${timings.length} file(s) in ${(profileDuration / 1000).toFixed(1)}s ` +
        `(sequential sum: ${(sequentialSum / 1000).toFixed(1)}s, concurrency: ${PROFILE_CONCURRENCY})`,
    );

    // Update cache with fresh timings
    for (const { file, ms } of timings) {
      cache[file] = { hash: hashes[file], timeMs: ms };
    }

    saveTimings(TIMING_CACHE_PATH, cache);
  } else {
    console.log("\n--- Test Timing Profile (incremental) ---");
    console.log("All test files unchanged — skipping profiling.");
    if (pruned > 0) {
      console.log(`Pruned ${pruned} stale cache entries`);
      saveTimings(TIMING_CACHE_PATH, cache);
    }
  }

  // Report top 10 slowest from the full cache (including cached entries)
  const allTimings = testFiles
    .filter((f) => cache[f]?.timeMs != null)
    .map((f) => ({ file: f, ms: cache[f].timeMs }))
    .sort((a, b) => b.ms - a.ms);

  if (allTimings.length > 0) {
    console.log(
      `\nTop 10 slowest test files (budget: ${PER_FILE_TIME_BUDGET_MS}ms, ${Object.keys(TIMING_EXCLUSIONS).length} excluded):`,
    );
    for (const { file, ms } of allTimings.slice(0, 10)) {
      const excluded = Object.keys(TIMING_EXCLUSIONS).some((pattern) => file.endsWith(pattern));
      const marker = ms > PER_FILE_TIME_BUDGET_MS ? (excluded ? " (excluded)" : " ← OVER BUDGET") : "";
      console.log(`  ${String(ms).padStart(6)}ms  ${file}${marker}`);
    }

    // Warn (never fail) on budget violations
    const overBudget = allTimings.filter((t) => {
      if (t.ms <= PER_FILE_TIME_BUDGET_MS) return false;
      return !Object.keys(TIMING_EXCLUSIONS).some((pattern) => t.file.endsWith(pattern));
    });
    if (overBudget.length > 0) {
      console.warn(`\nWARN: ${overBudget.length} test file(s) exceed ${PER_FILE_TIME_BUDGET_MS}ms per-file budget:`);
      for (const { file, ms } of overBudget) {
        console.warn(`  ${ms}ms  ${file}`);
      }
      console.warn("\nConsider extracting pure logic into unit tests or splitting the file.");
    }

    // --- Aggregate time ratchet (sequential sum of non-excluded files) ---
    const nonExcludedTimings = allTimings.filter(
      (t) => !Object.keys(TIMING_EXCLUSIONS).some((pattern) => t.file.endsWith(pattern)),
    );
    const aggregateMs = nonExcludedTimings.reduce((sum, t) => sum + t.ms, 0);
    console.log(
      `\nAggregate test time (non-excluded): ${(aggregateMs / 1000).toFixed(1)}s ` +
        `(budget: ${(AGGREGATE_TIME_BUDGET_MS / 1000).toFixed(0)}s, ${nonExcludedTimings.length} files)`,
    );
    if (aggregateMs > AGGREGATE_TIME_BUDGET_MS) {
      console.warn(
        `\nWARN: Aggregate test time ${(aggregateMs / 1000).toFixed(1)}s exceeds ${(AGGREGATE_TIME_BUDGET_MS / 1000).toFixed(0)}s budget. Optimize slow test files or raise the budget if justified.`,
      );
    }
  } // end runProfiling
} // end if (!runProfiling) else

if (failed) {
  process.exit(1);
}

console.log("\nPASS: All coverage thresholds met.\n");
