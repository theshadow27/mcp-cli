#!/usr/bin/env bun
/**
 * Test file timing profiler.
 *
 * Discovers all *.spec.ts files, runs each individually via `bun test`,
 * measures wall-clock duration per file across multiple runs, and outputs
 * a sorted report with mean/min/max/stddev.
 *
 * Usage:
 *   bun scripts/test-timing.ts              # 3 runs, all spec files
 *   bun scripts/test-timing.ts --runs 5     # 5 runs
 *   bun scripts/test-timing.ts --top 10     # only show top 10 slowest
 *   bun scripts/test-timing.ts --json       # JSON output to stdout
 *   bun scripts/test-timing.ts --timeout 30 # 30s per-test timeout (default: 60)
 */

import { Glob } from "bun";

// --- Argument parsing ---

function parseArgs(argv: string[]): {
  runs: number;
  top: number;
  json: boolean;
  timeout: number;
} {
  let runs = 3;
  let top = 0; // 0 = show all
  let json = false;
  let timeout = 60; // seconds

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs" && argv[i + 1]) {
      runs = Number.parseInt(argv[i + 1], 10);
      if (Number.isNaN(runs) || runs < 1) {
        console.error("--runs must be a positive integer");
        process.exit(1);
      }
      i++;
    } else if (argv[i] === "--top" && argv[i + 1]) {
      top = Number.parseInt(argv[i + 1], 10);
      if (Number.isNaN(top) || top < 1) {
        console.error("--top must be a positive integer");
        process.exit(1);
      }
      i++;
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      timeout = Number.parseInt(argv[i + 1], 10);
      if (Number.isNaN(timeout) || timeout < 1) {
        console.error("--timeout must be a positive integer (seconds)");
        process.exit(1);
      }
      i++;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }

  return { runs, top, json, timeout };
}

// --- Statistics ---

interface FileTimings {
  file: string;
  durations: number[]; // seconds
  mean: number;
  min: number;
  max: number;
  stddev: number;
  failures: number;
  timedOut: boolean;
}

interface RunResult {
  duration: number;
  exitCode: number;
  timedOut: boolean;
}

function computeStats(file: string, runs: RunResult[]): FileTimings {
  const durations = runs.map((r) => r.duration);
  const failures = runs.filter((r) => r.exitCode !== 0).length;
  const timedOut = runs.some((r) => r.timedOut);
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const min = durations.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const max = durations.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
  const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
  const stddev = Math.sqrt(variance);
  return { file, durations, mean, min, max, stddev, failures, timedOut };
}

// --- File discovery ---

const EXCLUDED_DIRS = ["node_modules", "dist", "build", ".claude"];

async function discoverSpecFiles(): Promise<string[]> {
  const glob = new Glob("**/*.spec.ts");
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: process.cwd(), absolute: false })) {
    if (EXCLUDED_DIRS.some((dir) => path.startsWith(`${dir}/`))) continue;
    files.push(path);
  }
  return files.sort();
}

// --- Run a single test file ---

async function timeTestFile(file: string, timeoutSec: number): Promise<RunResult> {
  const start = Bun.nanoseconds();
  const proc = Bun.spawn(["bun", "test", file], {
    stdout: "ignore",
    stderr: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutSec * 1000);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const duration = (Bun.nanoseconds() - start) / 1e9; // seconds
  return { duration, exitCode, timedOut };
}

// --- Formatting ---

function formatDuration(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${(seconds * 1000).toFixed(0)}ms`;
}

function printReport(results: FileTimings[], opts: { runs: number; top: number }): void {
  const display = opts.top > 0 ? results.slice(0, opts.top) : results;
  const total = results.reduce((sum, r) => sum + r.mean, 0);

  const maxFileLen = Math.max(...display.map((r) => r.file.length), 30);
  const lineWidth = Math.max(maxFileLen + 30, 65);
  console.error(`\nTest File Timing Report (${opts.runs} run${opts.runs === 1 ? "" : "s"})`);
  console.error("═".repeat(lineWidth));
  const maxRank = String(display.length).length;
  for (let i = 0; i < display.length; i++) {
    const r = display[i];
    const rank = String(i + 1).padStart(maxRank);
    const time = formatDuration(r.mean).padStart(7);
    const dev = `± ${formatDuration(r.stddev)}`;
    const status = r.timedOut ? " TIMEOUT" : r.failures > 0 ? ` FAIL(${r.failures})` : "";
    console.error(`  ${rank}. ${r.file.padEnd(maxFileLen)} ${time} ${dev}${status}`);
  }

  console.error("═".repeat(lineWidth));
  console.error(`Total: ${formatDuration(total)} across ${results.length} files`);
  if (opts.top > 0 && opts.top < results.length) {
    console.error(`(showing top ${opts.top} of ${results.length})`);
  }
  console.error();
}

// --- Main ---

const opts = parseArgs(process.argv.slice(2));
const files = await discoverSpecFiles();

if (files.length === 0) {
  console.error("No *.spec.ts files found.");
  process.exit(1);
}

console.error(
  `Found ${files.length} test files, running ${opts.runs} iteration${opts.runs === 1 ? "" : "s"} each...\n`,
);

const runResults: Map<string, RunResult[]> = new Map();

for (let run = 0; run < opts.runs; run++) {
  console.error(`Run ${run + 1}/${opts.runs}...`);
  for (const file of files) {
    const result = await timeTestFile(file, opts.timeout);
    const existing = runResults.get(file) ?? [];
    existing.push(result);
    runResults.set(file, existing);
  }
}

const results: FileTimings[] = [];
for (const [file, runs] of runResults) {
  results.push(computeStats(file, runs));
}

// Sort by mean descending (slowest first)
results.sort((a, b) => b.mean - a.mean);

// Console report
printReport(results, opts);

// JSON artifact
const report = {
  timestamp: new Date().toISOString(),
  runs: opts.runs,
  files: results.map((r) => ({
    file: r.file,
    mean: Number(r.mean.toFixed(4)),
    min: Number(r.min.toFixed(4)),
    max: Number(r.max.toFixed(4)),
    stddev: Number(r.stddev.toFixed(4)),
    failures: r.failures,
    timedOut: r.timedOut,
    durations: r.durations.map((d) => Number(d.toFixed(4))),
  })),
};

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  await Bun.write("test-timing-report.json", `${JSON.stringify(report, null, 2)}\n`);
  console.error("Written to test-timing-report.json");
}

// Exit non-zero if any test files had failures
const totalFailures = results.reduce((sum, r) => sum + r.failures, 0);
const anyTimedOut = results.some((r) => r.timedOut);
if (totalFailures > 0 || anyTimedOut) {
  console.error(
    `\n⚠ ${totalFailures} failure(s)${anyTimedOut ? ", with timeouts" : ""} detected — timings for failed tests may be misleading.`,
  );
  process.exit(1);
}
