#!/usr/bin/env bun
/**
 * Coverage threshold enforcement.
 *
 * Parses `bun test --coverage` text output and exits non-zero if:
 *   1. Overall coverage drops below global thresholds (ratchet)
 *   2. Any individual file drops below per-file minimum (unless excluded)
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

import { logTestRun } from "./test-failure-log";

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

if (failed) {
  process.exit(1);
}

console.log("\nPASS: All coverage thresholds met.\n");
