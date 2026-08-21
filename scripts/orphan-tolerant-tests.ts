/**
 * Single source of truth for the test files structurally exempted from
 * `bun test --no-orphans`.
 *
 * `--no-orphans` (sprint 64, #2394) recursively kills every descendant of the
 * `bun test` process tree on exit — including a child that was deliberately
 * detached (via `handle.unref()` in `packages/command/src/daemon-lifecycle.ts`'s
 * `startDaemon()`) to outlive its spawner. `test/stress.spec.ts`'s S1 test spawns
 * real `mcx` CLI processes that race to auto-start a real `mcpd` daemon; the
 * daemon is meant to survive after the `mcx` process that spawned it exits —
 * that's the auto-start contract under test. `--no-orphans` kills it before the
 * losing `mcx` processes can reach it, which is a structural conflict, not a bug
 * in the test: no amount of test-code cleverness reconciles "verify the daemon
 * outlives its spawner" with "nothing may outlive its spawner". Confirmed via
 * oven-sh/bun#13675 (closed, maintainer-verified) and #619.
 *
 * Every `bun test` invocation that would otherwise apply `--no-orphans` over a
 * path containing one of these files must exclude it (typically via
 * `--path-ignore-patterns`) and run it separately, without the flag. Any test
 * claiming this exception is required to explicitly track and kill+verify-dead
 * every process it starts — see `test/harness.ts`'s `reapDaemonPidFile` /
 * `killAndVerifyDead` for the pattern, and `test/CLAUDE.md`'s "Orphan-tolerant
 * tests" section for the full write-up.
 *
 * Deliberately a standalone const-only module (mirrors `bun-summary.ts`) so a
 * bun upgrade or file rename can't let the exclusion drift out of lockstep
 * across the call sites (package.json, am-i-done.ts, ci-steps.ts,
 * check-coverage.ts, test-timing.ts), and so importing it never drags
 * un-exercised function bodies into the coverage per-file floor.
 *
 * NOTE: package.json's `test` script is plain JSON and cannot import this
 * constant — it mirrors this list by hand. Keep the two in sync.
 */
export const ORPHAN_TOLERANT_TEST_FILES: readonly string[] = ["test/stress.spec.ts"];
