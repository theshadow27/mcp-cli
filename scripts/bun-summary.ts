/**
 * Shared parse contract for bun test's end-of-run summary line, e.g.
 * "Ran 6158 tests across 225 files. [57.07s]".
 *
 * This is the single source of truth for the regex so a bun-upgrade reword
 * can't drift the copies in ci-steps.ts and coverage-report.ts out of lockstep
 * (#2883). It is deliberately a standalone const-only module: importing a file
 * with function bodies into the covered scripts/_runner graph would pull those
 * un-exercised functions into the coverage table (ci-steps.spec runs in the
 * coverage gate but coverage-report.spec does not), sinking the per-file floor.
 * A top-level const is 100% executed on import, so it never drags coverage.
 */
export const RAN_FILES_RE = /^Ran \d+ tests? across (\d+) files?/m;
