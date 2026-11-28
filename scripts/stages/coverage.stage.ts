import { readFileSync } from "node:fs";
import type { Stage, StageOptions, StageResult } from "am-i-done";
import { tmpFile } from "am-i-done/tmp";

import { classifyCoverage, isBunPanic, parseCoverageSummary, persistLog, realRunner } from "./_lib/bun-test";
import { MAX_LEASE_WAIT_MS, withLease } from "./_lib/lease";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One check-coverage.ts run in CI form, classified with the #1419 tolerance. */
async function ciAttempt(options: StageOptions, logName: string): Promise<StageResult & { panic: boolean }> {
  using summary = tmpFile("coverage-summary.json");
  const outcome = await realRunner(options)(["scripts/check-coverage.ts", "--ci", `--junit-outfile=${summary.path}`], {
    cwd: options.root,
    junit: false,
  });
  persistLog(options.root, logName, outcome.output);
  const verdict = classifyCoverage(outcome, parseCoverageSummary(readOrNull(summary.path)));
  if (verdict.success && outcome.code !== 0)
    options.logger.warn(`bun crash (exit ${outcome.code}) after the coverage check passed — treating as pass (#1419)`);
  return { ...verdict, output: outcome.output, panic: isBunPanic(outcome.code, outcome.signal) };
}

/**
 * The coverage ratchet (scripts/check-coverage.ts): never lower its thresholds. In CI it runs the
 * whole suite (`--ci`), with the #1419 tolerance and one retry on a Bun panic; locally it runs the
 * non-daemon half under the gate lease.
 */
export default {
  id: "coverage",
  description: "coverage ratchet — never lower thresholds (scripts/check-coverage.ts)",
  phase: "test",
  modes: ["default", "ci"],
  // The ratchet runs the suite again, so it comes last; a test failure stops the run before it.
  after: ["test", "test-non-daemon", "test-daemon", "test-phases", "test-hooks"],
  cores: "max",
  timeoutMs: MAX_LEASE_WAIT_MS + 300_000,
  command: async (options) => {
    if (options.context !== "ci" && options.mode !== "ci") {
      return withLease(options, async () => {
        const r = await realRunner(options)(["scripts/check-coverage.ts"], { cwd: options.root, junit: false });
        return r.code === 0
          ? { success: true, output: r.output }
          : { success: false, error: `exit ${r.code}`, output: r.output };
      });
    }
    const first = await ciAttempt(options, "coverage_out");
    if (first.success || !first.panic) return { success: first.success, error: first.error, output: first.output };
    options.logger.warn("bun panic during the coverage run — retrying once (#1419)");
    const second = await ciAttempt(options, "coverage_out_retry");
    return { success: second.success, error: second.error, output: `${first.output}\n--- retry ---\n${second.output}` };
  },
  onFailure: [
    "ratchet failure: add tests to restore coverage — never lower thresholds (scripts/check-coverage.ts)",
    "post-test Bun crash (#1419): output should contain `PASS: All coverage thresholds met`",
  ],
} satisfies Stage;
