# Test Guidelines — Flaky Test Prevention

These rules apply to all `*.spec.ts` files. Follow them to prevent intermittent CI failures.

## Core philosophy — test the CONDITION, not TIME PASSING

Adopted from Bun's upstream testing guidelines, the principle our enforcement rules
mechanize (`poll-until-headroom`, `no-hardcoded-test-port`, `pollUntil` 1500ms default):

> **CRITICAL: Do not write flaky tests. Do not use `setTimeout` in tests. Instead,
> await the condition to be met. You are not testing the TIME PASSING, you are
> testing the CONDITION.**

> Unless explicitly asked, never wait for time to pass in tests. Always wait for
> the condition to be met instead of waiting for an arbitrary amount of time.

This is the *why* behind every rule below. Sleeping a fixed number of milliseconds
encodes an assumption about machine speed; condition-polling does not. CI runners,
loaded developer machines, and parallel test workers all break the assumption — a
2026 M-series Mac at idle is not the same as a GitHub Actions runner with 4 vCPU
under contention.

## Per-test timeouts

> **CRITICAL: Do not set a timeout on tests. Bun already has timeouts.**

Use `setDefaultTimeout()` at file scope when a file's tests genuinely need longer
than Bun's default (e.g. tests doing real subprocess startup, network polling, or
filesystem-heavy work). Per-test `{ timeout: N }` overrides are a code smell —
they hide a single slow test inside a fast file and make the slowdown invisible
to the time-budget profiler. If one test in a file needs 30s and the rest run in
under a second, the file's `setDefaultTimeout(30_000)` is the right knob; the
profiler then surfaces the file as a candidate for splitting.

## Existing Test Helpers

Before writing new helpers, check what already exists:
- `test/harness.ts` — `startTestDaemon`, `rpc`, `createTestDir`, `echoServerConfig` for integration tests
- `test/test-options.ts` — `testOptions` with temp dir setup and `Symbol.dispose` cleanup
- `test/env.ts` — `unsetEnv` / `restoreEnv` for save-mutate-restore around `process.env`.
  **Never write `process.env.FOO = undefined`** — it stringifies to the literal
  `"undefined"` (truthy) instead of removing the key, and leaks into every later test
  in the file (#2984)
- `packages/daemon/src/test-helpers.ts` — `makeConfig`, `makeMockTransport`, `makeMockClient`

## Real ~/.mcp-cli isolation (required — #3233)

No spec may touch the real, production `~/.mcp-cli` (socket, database, daemon
process, or config). `test/preload-mcp-cli-isolation.ts` (wired into
`bunfig.toml`) pins `MCP_CLI_DIR` to a throwaway per-run temp dir before any
module can read the real default, so this can't happen even by accident —
but treat it as a backstop, not a license to skip explicit isolation:

- In-process code under test (anything reading `options.MCP_CLI_DIR`
  directly): use `test/test-options.ts`'s `testOptions()` — gives each test
  its own temp dir via `using`/`Symbol.dispose` cleanup.
- A spawned `mcx`/`mcpd` subprocess: pass an explicit `MCP_CLI_DIR` override
  in its `env` (see `test/harness.ts`'s `startTestDaemon`, `test/stress.spec.ts`'s
  `mcx()` helper) — don't rely on the preload's shared default, which is one
  directory per test *process*, not per test.
- Never derive an `.mcp-cli` path from `homedir()` yourself — read
  `options.MCP_CLI_DIR` instead. The `no-real-mcp-cli-home` doing-it-wrong
  rule (`scripts/rules/no-real-mcp-cli-home.rule.ts`) flags both a
  `homedir() + ".mcp-cli"` string-build and a hardcoded absolute real-home
  path used in a filesystem call.

## Core Rules

1. **Never use `setTimeout` for waiting** — await the condition directly
2. **Never hardcode ports** — use `port: 0` for OS-assigned ports
3. **Prefer Bun's default test timeout** — only override when a test genuinely needs longer (e.g., integration tests with polling)
4. **Tests must pass without claude on PATH** — the `check-no-claude` CI job runs `bun test` with claude stripped from PATH and `MCX_CLAUDE_BINARY` unset. Tests that exercise claude-session behavior must inject a synthetic claude binary via `startTestDaemon`'s `pathPrefix` option (see `test/harness.ts`) pointing to `test/mock-claude.ts`. Never rely on the real `claude` binary being available.

## Subprocess Spawning

Prefer `await using` for automatic cleanup:

```ts
await using proc = Bun.spawn({ cmd: ["bun", ...], env: process.env });
```

Always collect all outputs simultaneously:

```ts
const [stdout, stderr, exitCode] = await Promise.all([
  proc.stdout.text(),
  proc.stderr.text(),
  proc.exited,
]);
```

Assert `stdout`/`stderr` **before** `exitCode` — gives better error messages on failure.

## Orphan-tolerant tests

`bun test --no-orphans` is the default expectation for every test in this suite — it
recursively kills any descendant process left running when the `bun test` tree exits,
which is what makes real leaked fixtures/workers visible instead of silently piling up
on the host (sprint 64, #2394).

`test/stress.spec.ts` (S1: Concurrent auto-start) is the one deliberate, narrow
exception. It spawns real `mcx` CLI processes that race to auto-start a real `mcpd`
daemon; the daemon is *meant* to outlive the `mcx` process that spawned it — that's the
auto-start contract under test. `--no-orphans` kills the daemon before the losing `mcx`
processes can reach it. This isn't a test bug or a loophole to close: verifying "the
daemon survives its spawner" is structurally incompatible with a flag whose contract is
"nothing survives its spawner". No amount of test-code cleverness reconciles the two.
Confirmed against `oven-sh/bun#13675` (closed, maintainer-verified) and #619 — see that
issue for the full investigation.

The exception is not free: **any test claiming it must explicitly track and
kill+verify-dead every process it causes to be started**, so leak-prevention becomes the
test's own responsibility instead of the flag's. Use `test/harness.ts`'s
`reapDaemonPidFile(dir)` (reads `mcpd.pid`, kills it, and polls until the PID is
confirmed dead — escalating SIGTERM → SIGKILL, never fire-and-forget) or the lower-level
`killAndVerifyDead(pid)` it's built on. Both log loudly to stderr on every path — found a
daemon and reaped it, found nothing to reap, or (a real leak) survived SIGKILL — so a
future orphan is visible in test output, not silently trusted away. `test/stress.spec.ts`
S1's `afterEach` is the reference usage; copy it for the next test that genuinely needs
this exception. The corresponding `--no-orphans` scoping lives in
`scripts/orphan-tolerant-tests.ts` (single source of truth for which files are exempt)
and is mirrored at every `bun test` call site that would otherwise apply the flag
suite-wide (`package.json`, `scripts/am-i-done.ts`, `scripts/_runner/ci-steps.ts`,
`scripts/check-coverage.ts`, `scripts/test-timing.ts`) — adding a new orphan-tolerant
file means updating that constant, not re-deriving the exclusion at each site.

## Waiting for Readiness

**Anti-pattern:** `await Bun.sleep(500)` then assume ready

**Correct:** Poll with a deadline, sleep only between failed attempts:

```ts
async function waitForUnixSocket(path: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const err = await new Promise(resolve => {
      Bun.connect({
        unix: path,
        socket: {
          open: (socket) => { resolve(undefined); socket.end(); },
          error: (_, e) => resolve(e),
          connectError: (_, e) => resolve(e),
        },
      });
    });
    if (!err) return;
    await Bun.sleep(100);
  }
  throw new Error(`Unix socket ${path} not ready within ${timeout}ms`);
}
```

For TCP, follow the same polling pattern. The key principle: try the condition, sleep only on failure, retry until a deadline. See `test/harness.ts` for a working example (`startTestDaemon` polls the daemon socket with ping RPCs).

| Anti-pattern | Correct |
|---|---|
| `await Bun.sleep(500)` then assume ready | Poll with deadline, sleep between retries |
| Fixed wait, hope it's enough | Exits as soon as condition is met |
| Breaks in slow CI, wastes time when fast | Adapts to actual speed |

## Process Exit

Don't poll for PIDs. Just `await proc.exited` — it's a native promise that resolves on termination.

## Waiting for Async Side Effects

When testing debounced or async callbacks, use a deadline-based poll helper instead of fixed delays:

```ts
async function waitForCall(fn: Mock, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fn.mock.calls.length === 0 && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}
```

This pattern also works for asserting state changes, event emissions, or any condition that resolves asynchronously.

**Exception:** A standalone sleep is acceptable when asserting that something does NOT happen within a time window (negative assertions). For example, testing that a debounced callback does not fire prematurely.

## Test Time Budget

No single test file should take more than **5 seconds** in isolation. The pre-commit hook (`scripts/check-coverage.ts`) profiles every test file and fails if any exceeds this budget.

If a test file is too slow:
1. **Extract pure logic** — state machines, hash functions, diffing algorithms can be unit-tested without spinning up real servers or workers
2. **Reduce sleep budgets** — if testing a 300ms debounce, use `TEST_DEBOUNCE_MS = 50` in tests
3. **Split the file** — separate fast unit tests from slow integration tests (e.g., `foo.spec.ts` for units, `foo.integration.spec.ts` for integration)
4. **Use `pollUntil`** instead of fixed sleeps — exits as soon as the condition is met

## DB/IPC Restore Paths: test the absent-field case (required)

Whenever a column is added to a session/DB restore path (or a field to an IPC
payload parser), tests must cover **both** scenarios:

- **Field present:** row contains the new column with a valid value → restore uses it
- **Field absent/null/garbage:** row is missing the column (older DB schema),
  stores NULL, or holds an unrecognised value → restore uses the safe default —
  no crash, no silent wrong value

Motivating incident (#2602): a `transport` TEXT column was added with no CHECK
constraint and restored via `row.transport as "ws" | "stdio"` — the cast let
garbage bypass the `?? "ws"` fallback and silently drop messages. Only the
happy path was tested; the absent-field path (the one that hit production) had
no coverage. The `no-db-ipc-cast` rule (#2622) bans the bare-cast half of this
bug class; this test pattern is the other half.

## Domain-scoped lookups: assert the resolved row, not that something fired

Anything that resolves a work item from an event — automation dispatch, the
GitHub pollers, phase scripts — resolves it *within a partition*. "It ran" and
"it ran against the right row" are different claims, and only the second one is
worth a test.

- Seed a work item in a domain **other** than the one under test (including
  `NO_DOMAIN_ID`, which is where every row on an un-migrated box still lives),
  not just the happy-path one.
- Assert the resolved id (`getAuditLog()[0].workItemId`, the patched row, the
  fetched PR numbers) — never `fired.length > 0`.

Motivating incident (#3397 review): a sole automation dispatcher on a registered
domain accepted events that resolved to no domain, but its work-item lookups
were scoped to its own partition and structurally could not see the rows those
events were about. The existing test published such an event and asserted only
that the module fired — which it did, with no work item at all — so a silent
no-op (and, on a PR-number collision, a `bye-and-untrack` against the wrong row)
passed a green suite.

## Summary

Every `Bun.sleep` or `setTimeout` in a test is a potential flake. If you must sleep, it should be inside a retry/poll loop with a deadline — never as "wait and hope". The two acceptable standalone sleeps are: short backoff between retry attempts, and negative assertions (verifying something does NOT happen).
