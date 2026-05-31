/**
 * Entry point for the `check-no-claude` CI job: run the full test suite with
 * the #1004/#1419 crash-after-pass tolerance, on a claude-free PATH.
 *
 * The workflow strips every directory containing a `claude` binary from PATH
 * (so a test that secretly shells out to `claude` fails loudly) and then runs
 * this script.
 *
 * Why two batches instead of one `bun test`: the daemon tests spawn real
 * daemons + subprocesses and destabilise Bun 1.3.14's end-of-process teardown.
 * Running the whole suite (daemon + non-daemon) in a single invocation tipped
 * the CI runner into a late-run SIGTERM ~96% through — 8586/8798 tests passed,
 * 0 failed, then the process was killed before flushing any summary, so neither
 * the junit file nor the `0 fail` stdout line existed for the classifier to
 * trust (#2641). The required `check` job never hit this because it already
 * splits the daemon tests into their own invocation. We mirror that split here
 * while still covering the *whole* suite: batch 1 is everything EXCEPT the
 * daemon paths (via --path-ignore-patterns), batch 2 is the daemon paths.
 *
 * Both batches go through `bunTestWithCrashTolerance` — the same junit-based
 * classifier `check` uses — so a clean run that crashes only at teardown is a
 * pass. This is a process-boundary shim (spawns `bun test`, then process.exit)
 * and is excluded from the per-file coverage ratchet, like scripts/release.ts;
 * its behaviour lives in bunTestWithCrashTolerance, covered by ci-steps.spec.ts.
 */
import { DAEMON_TEST_PATHS } from "../am-i-done";
import { bunTestWithCrashTolerance } from "./ci-steps";
import { createConsoleLogger } from "./logger";

function ok(result: Awaited<ReturnType<ReturnType<typeof bunTestWithCrashTolerance>>>): boolean {
  return typeof result === "boolean" ? result : (result?.success ?? false);
}

const logger = createConsoleLogger();
const opts = { args: [] as string[], env: process.env, logger };

// Daemon dirs → "<dir>/**" globs; daemon spec files stay literal.
const daemonIgnores = DAEMON_TEST_PATHS.map((p) => (p.endsWith(".spec.ts") ? p : `${p}/**`)).map(
  (p) => `--path-ignore-patterns=${p}`,
);

// Batch 1: the whole suite minus the daemon tests.
const nonDaemon = bunTestWithCrashTolerance({ paths: daemonIgnores, logName: "test_no_claude", retryOn132: false });
if (!ok(await nonDaemon(opts))) process.exit(1);

// Batch 2: the daemon tests (sequential; SIGILL retry, as `check` does).
const daemon = bunTestWithCrashTolerance({
  paths: DAEMON_TEST_PATHS,
  logName: "test_no_claude_daemon",
  retryOn132: true,
});
process.exit(ok(await daemon(opts)) ? 0 : 1);
