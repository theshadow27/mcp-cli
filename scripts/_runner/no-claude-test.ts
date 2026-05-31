/**
 * Entry point for the `check-no-claude` CI job: run the full test suite with
 * the #1004/#1419 crash-after-pass tolerance, claude-free PATH.
 *
 * The workflow strips every directory containing a `claude` binary from PATH
 * (so a test that secretly shells out to `claude` fails loudly) and then runs
 * this script. We re-use `bunTestWithCrashTolerance` — the exact junit-based
 * classifier the required `check` job uses — instead of the old raw `bun test`
 * + `grep "^ 0 fail$"` bash, which leaked Bun's post-teardown SIGTERM (exit
 * 143) as a red build: the grep needs the summary line, but a teardown crash
 * can SIGTERM the worker AFTER all tests pass but BEFORE the summary flushes.
 * The junit reporter records `failures="0"` on disk and survives that crash;
 * the `ZERO_FAIL_RE` stdout fallback covers the case where even the file is
 * lost (#2641).
 *
 * This is a process-boundary shim (spawns `bun test`, then `process.exit`) and
 * is therefore excluded from the per-file coverage ratchet, like
 * `scripts/release.ts`. The behaviour it depends on lives in
 * `bunTestWithCrashTolerance` and is fully covered by `ci-steps.spec.ts`.
 */
import { bunTestWithCrashTolerance } from "./ci-steps";
import { createConsoleLogger } from "./logger";

// Empty `paths` → whole suite (one invocation, matching the job's original
// scope). retryOn132 because the suite includes the daemon tests, which
// historically need the SIGILL retry.
const step = bunTestWithCrashTolerance({ paths: [], logName: "test_no_claude", retryOn132: true });
const result = await step({ args: [], env: process.env, logger: createConsoleLogger() });
const success = typeof result === "boolean" ? result : (result?.success ?? false);
process.exit(success ? 0 : 1);
