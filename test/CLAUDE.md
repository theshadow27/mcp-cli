# Test Guidelines — Flaky Test Prevention

These rules apply to all `*.spec.ts` files. Follow them to prevent intermittent CI failures.

## Core Rules

1. **Never use `setTimeout` for waiting** — await the condition directly
2. **Never hardcode ports** — use `port: 0` for OS-assigned ports
3. **Never set test timeouts** — Bun has built-in timeouts already

## Subprocess Spawning

Use `await using` for automatic cleanup:

```ts
await using proc = Bun.spawn({ cmd: [bunExe(), ...], env: bunEnv });
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

Use `Promise.withResolvers()` instead of manual callback wrappers.

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
          data: (socket) => { resolve(undefined); socket.end(); },
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

For TCP, use the existing `waitForPort()` helper pattern. The key principle: try the condition, sleep only on failure, retry until a deadline.

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

## Summary

Every `Bun.sleep` or `setTimeout` in a test is a potential flake. If you must sleep, it should be inside a retry/poll loop with a deadline — never as "wait and hope". The only acceptable standalone sleep is a short backoff between retry attempts.
