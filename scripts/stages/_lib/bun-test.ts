/**
 * `bun test` runs for the gate's test stages, with the crash tolerance the repo has carried since
 * Bun 1.3 (moved here from the old runner's `scripts/_runner/ci-steps.ts`).
 *
 * Two crash signatures have masqueraded as test failures after the suite passed:
 *
 *   - #1004: SIGILL (exit 132) or a post-cleanup exit 1 AFTER every test completed, so the summary
 *     still reads " 0 fail". That is not a failure.
 *   - #1419: check-coverage.ts panicking during teardown. "PASS: All coverage thresholds met" (or
 *     " 0 fail" with no FAIL: line) in the output is authoritative; the exit code is not.
 *
 * A run that panicked (SIGSEGV/SIGILL/SIGBUS/SIGTRAP/SIGABRT, or exit 132/139) before printing any
 * pass evidence gets ONE retry; a second panic without pass evidence fails (#2780). The junit
 * report is the primary pass signal and the stdout summary the fallback, since a teardown crash can
 * lose the junit file but not the incrementally written summary (#2401). An "Unhandled error
 * between tests" counts as a failure even when every test passed (#2669).
 *
 * Each run's output is kept in `build/test-logs/<name>.txt` (`<name>_retry.txt` on a retry) for
 * CI's artefact upload.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, type StageOptions, type StageResult, spawnCaptured } from "am-i-done";
import { tmpFile } from "am-i-done/tmp";

import { RAN_FILES_RE } from "../../bun-summary";

export const LOG_DIR = "build/test-logs";

export interface RunOutcome {
  code: number;
  /** The signal that ended the child, if one did (Linux reports a SIGSEGV as code null + signal, #2754). */
  signal: string | null;
  output: string;
  /** junit `failures` + `errors`, or null when the report is missing. */
  junitFailures: number | null;
  /** junit `tests` on the root element, or null when the report is missing. */
  junitTests: number | null;
}

export function isBunPanic(code: number, signal: string | null): boolean {
  return (
    code === 132 ||
    code === 139 ||
    signal === "SIGSEGV" ||
    signal === "SIGILL" ||
    signal === "SIGBUS" ||
    signal === "SIGTRAP" ||
    signal === "SIGABRT"
  );
}

/** `failures` plus `errors` from a junit report; an unhandled error between tests counts in `errors`. */
export function parseJunitFailures(xml: string | null): number | null {
  if (xml === null) return null;
  const fm = xml.match(/failures="(\d+)"/);
  const em = xml.match(/errors="(\d+)"/);
  if (!fm && !em) return null;
  return (fm ? Number.parseInt(fm[1] as string, 10) : 0) + (em ? Number.parseInt(em[1] as string, 10) : 0);
}

/** The root `tests` attribute (the first in document order) of a junit report. */
export function parseJunitTests(xml: string | null): number | null {
  if (xml === null) return null;
  const m = xml.match(/tests="(\d+)"/);
  return m ? Number.parseInt(m[1] as string, 10) : null;
}

export const ZERO_FAIL_RE = /^ 0 fail$/m;
// Column 0 only: test NAMES that quote the phrase are echoed mid-line (#2744).
export const COVERAGE_PASS_RE = /^PASS: All coverage thresholds met/m;
export const FAIL_LINE_RE = /^FAIL:/m;
const UNHANDLED_ERROR_RE = /Unhandled error between tests/;
const NONZERO_ERRORS_RE = /^\s*([1-9]\d*) errors?\b/m;

export function hasUnhandledError(output: string): boolean {
  return UNHANDLED_ERROR_RE.test(output) || NONZERO_ERRORS_RE.test(output);
}

/** The run recorded zero failures: by its junit report, or by its summary line when the report is gone. */
export function hasZeroFailures(outcome: RunOutcome): boolean {
  if (outcome.junitFailures === 0) return true;
  if (outcome.junitFailures === null) return ZERO_FAIL_RE.test(outcome.output) && !hasUnhandledError(outcome.output);
  return false;
}

/** Runs one command. A seam, so specs can feed canned outcomes. */
export type BunRunner = (argv: string[], opts: { cwd: string; junit: boolean }) => Promise<RunOutcome>;

/** The real runner: `bun <argv>` in its own process group, with a junit report for `bun test`. */
export function realRunner(options: StageOptions): BunRunner {
  return async (argv, { cwd, junit }) => {
    const report = junit && argv[0] === "test" ? tmpFile("junit.xml") : undefined;
    try {
      const full = report ? [...argv, "--reporter", "junit", `--reporter-outfile=${report.path}`] : argv;
      const r = await spawnCaptured(["bun", ...full], { cwd, env: options.env, signal: options.signal });
      let xml: string | null = null;
      if (report) {
        try {
          xml = readFileSync(report.path, "utf8");
        } catch {
          xml = null; // a teardown crash can lose the report; the summary line is the fallback
        }
      }
      if (r.error !== undefined) options.logger.error(`spawn error: ${r.error}`);
      return {
        code: r.code ?? -1,
        signal: r.signal,
        output: r.output,
        junitFailures: parseJunitFailures(xml),
        junitTests: parseJunitTests(xml),
      };
    } finally {
      report?.[Symbol.dispose]();
    }
  };
}

/** Keep a run's output for CI's artefact upload. Best effort. */
export function persistLog(root: string, name: string, output: string): void {
  try {
    mkdirSync(join(root, LOG_DIR), { recursive: true });
    writeFileSync(join(root, LOG_DIR, `${name}.txt`), output);
  } catch {
    // best effort: losing the artefact must not change the verdict
  }
}

export interface TestRun {
  argv: string[];
  name: string;
  cwd: string;
}

export interface Ctx {
  root: string;
  logger: Logger;
  run: BunRunner;
}

/** One `bun test` run with #1004 tolerance and one retry on a panic. */
export async function testWithCrashTolerance(ctx: Ctx, test: TestRun): Promise<StageResult & { outcome: RunOutcome }> {
  const first = await ctx.run(test.argv, { cwd: test.cwd, junit: true });
  persistLog(ctx.root, test.name, first.output);
  if (first.code === 0) return { success: true, output: first.output, outcome: first };
  if (hasZeroFailures(first)) {
    ctx.logger.warn(`bun crash (exit ${first.code}) after all tests passed — treating as pass (#1004)`);
    return { success: true, output: first.output, outcome: first };
  }
  if (!isBunPanic(first.code, first.signal))
    return { success: false, error: `exit ${first.code}`, output: first.output, outcome: first };

  ctx.logger.warn(`bun panic (exit ${first.code}, signal ${first.signal ?? "none"}) — retrying once (#1004)`);
  const second = await ctx.run(test.argv, { cwd: test.cwd, junit: true });
  persistLog(ctx.root, `${test.name}_retry`, second.output);
  const output = `${first.output}\n--- retry ---\n${second.output}`;
  if (second.code === 0) return { success: true, output, outcome: second };
  if (hasZeroFailures(second)) {
    ctx.logger.warn(`bun crash (exit ${second.code}) on retry after all tests passed — treating as pass (#1004)`);
    return { success: true, output, outcome: second };
  }
  // A double panic with no pass evidence is a failure, not a pass by policy (#2780).
  return { success: false, error: `exit ${second.code}`, output, outcome: second };
}

/** A run with #1004 tolerance after the summary, but no retry (the diff-aware and dir-scoped runs). */
export async function testTolerantNoRetry(ctx: Ctx, test: TestRun): Promise<StageResult & { outcome: RunOutcome }> {
  const outcome = await ctx.run(test.argv, { cwd: test.cwd, junit: true });
  persistLog(ctx.root, test.name, outcome.output);
  if (outcome.code === 0) return { success: true, output: outcome.output, outcome };
  if (hasZeroFailures(outcome)) {
    ctx.logger.warn(`bun crash (exit ${outcome.code}) after all tests passed — treating as pass (#1004)`);
    return { success: true, output: outcome.output, outcome };
  }
  return { success: false, error: `exit ${outcome.code}`, output: outcome.output, outcome };
}

/**
 * The run discovered at least as many spec files as exist on disk: `bun test` exits 0 having found
 * none, so a rename or a bunfig anchoring change would otherwise pass silently (#2719). The summary
 * line's file count first, else the junit test count; neither readable fails closed.
 */
export function checkDiscoveryFloor(outcome: RunOutcome, specCount: number): StageResult {
  const files = outcome.output.match(RAN_FILES_RE);
  const discovered = files ? Number.parseInt(files[1] as string, 10) : outcome.junitTests;
  if (discovered === null)
    return {
      success: false,
      error: "could not tell how many specs ran (no summary line, no junit tests attribute) — failing closed (#2719)",
    };
  if (discovered < specCount)
    return {
      success: false,
      error: `the run discovered ${discovered} ${files ? "files" : "tests"}, but ${specCount} spec files exist — check pathIgnorePatterns anchoring (#2719)`,
    };
  return { success: true };
}

/** check-coverage.ts's verdict, honouring #1419 (a panic after the ratchet passed). */
export function classifyCoverage(outcome: RunOutcome, summaryFailures: number | null): StageResult {
  const { code, output } = outcome;
  if (code === 0) return { success: true };
  // Its own FAIL: line means it did not pass, whatever PASS text appears elsewhere (#2744).
  if (COVERAGE_PASS_RE.test(output) && !FAIL_LINE_RE.test(output)) return { success: true };
  const clean = summaryFailures === 0 || (summaryFailures === null && ZERO_FAIL_RE.test(output));
  if (clean && !FAIL_LINE_RE.test(output) && !hasUnhandledError(output)) return { success: true };
  return { success: false, error: `exit ${code}` };
}

/** `{ failures: N }` written by check-coverage.ts --junit-outfile, or null. */
export function parseCoverageSummary(json: string | null): number | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { failures?: unknown };
    return typeof parsed.failures === "number" ? parsed.failures : null;
  } catch {
    return null;
  }
}

/** Every argument: several runs' output joined, for the stage's own output. */
export function joinOutputs(results: readonly { output?: string }[]): string {
  return results.map((r) => r.output ?? "").join("\n");
}
