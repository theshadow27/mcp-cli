/**
 * Failure signal for the post-compile daemon-worker smoke (build.ts).
 *
 * Anchored to the worker-backed server names the smoke asserts. A bare
 * /Failed to start/ over-matches: the daemon logs that same phrase for
 * metrics/tracing/mail/work-items servers, which are NOT worker-backed and are
 * unrelated to the `new Worker("./<name>")` entrypoint-resolution regression
 * this smoke guards. Matching them would false-fail the required `build` gate
 * on a transient init hiccup (e.g. a SQLite/FS blip in the isolated tmpdir) and
 * misdiagnose it as a worker startup failure. `ModuleNotFound` is the direct
 * worker-resolution signal. See #2800.
 */
export const WORKER_SMOKE_FAILURE_PATTERN =
  /ModuleNotFound|Failed to start (Claude session|Codex session|ACP session|OpenCode session|mock|site) server/;
