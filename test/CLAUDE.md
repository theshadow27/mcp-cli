# Test Guidelines — Flaky Test Prevention

These rules apply to all `*.spec.ts` files. Follow them to prevent intermittent CI failures.

## Existing Test Helpers

Before writing new helpers, check what already exists:
- `test/harness.ts` — `startTestDaemon`, `rpc`, `createTestDir`, `echoServerConfig` for integration tests
- `test/test-options.ts` — `testOptions` with temp dir setup and `Symbol.dispose` cleanup
- `packages/daemon/src/test-helpers.ts` — `makeConfig`, `makeMockTransport`, `makeMockClient`

## Core Rules

1. **Never use `setTimeout` for waiting** — await the condition directly
2. **Never hardcode ports** — use `port: 0` for OS-assigned ports
3. **Prefer Bun's default test timeout** — only override when a test genuinely needs longer (e.g., integration tests with polling)

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

## Summary

Every `Bun.sleep` or `setTimeout` in a test is a potential flake. If you must sleep, it should be inside a retry/poll loop with a deadline — never as "wait and hope". The two acceptable standalone sleeps are: short backoff between retry attempts, and negative assertions (verifying something does NOT happen).
