/**
 * Single source of truth for the `bun test --parallel` worker count.
 *
 * `--parallel` with no value defaults to CPU core count, so one gate run sizes
 * its fan-out to the whole host. That is what made concurrent `am-i-done` runs
 * across worktrees flood the box (#2690) and it is why the gate lease
 * (`packages/core/src/gate-lease.ts`) had to serialize them down to one at a
 * time — a correct fix for the flooding, and a miserable one to work under: a
 * queued run is a worker session sitting idle for the length of a peer's whole
 * suite.
 *
 * Pinning the fan-out instead means one run no longer wants the entire machine,
 * so concurrent runs cost a bounded, predictable slice each rather than
 * N × cores. 4 was chosen empirically over a derivation from core count: it is
 * roughly where the suite's wall time stops improving (the tail is dominated by
 * a handful of slow daemon/integration files, not by width), while leaving
 * enough of a 12-core host free that the agent sessions driving these runs stay
 * responsive.
 *
 * The lease is deliberately UNCHANGED by this — it still admits one run at a
 * time by default. This narrows the blast radius of a run that fails open past
 * its admission budget, and of anything that runs outside the gate entirely.
 *
 * Applies to CI too, on purpose: CI runners have ~4 cores, so `--parallel=4` is
 * what `--parallel` already resolved to there, and keeping one value keeps the
 * local and CI code paths identical (the whole point of `am-i-done --ci`).
 *
 * Deliberately a standalone const-only module (mirrors `orphan-tolerant-tests.ts`)
 * so the value can't drift across its call sites (am-i-done.ts, ci-steps.ts,
 * check-coverage.ts) and so importing it never drags un-exercised function
 * bodies into the coverage per-file floor.
 *
 * NOTE: package.json's `test` script is plain JSON and cannot import this
 * constant — it mirrors the flag by hand. Keep the two in sync.
 */
export const TEST_PARALLEL_WORKERS = 4;

/** `bun test` flag form, for call sites that build an argv array or a shell string. */
export const PARALLEL_FLAG = `--parallel=${TEST_PARALLEL_WORKERS}`;
