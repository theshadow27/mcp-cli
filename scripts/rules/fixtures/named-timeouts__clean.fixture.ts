/**
 * @rule named-timeouts
 * @expect 0
 * @path packages/daemon/src/example-timeouts-clean.ts
 *
 * Safe shapes: a named *_MS constant carries the meaning at the call site,
 * and literal 0 is an explicit "next tick" — both are allowed.
 */

declare const DEFAULT_TIMEOUT_MS: number;
declare const DEFAULT_POLL_INTERVAL_MS: number;
declare const ABORT_TIMEOUT_MS: number;
declare function fn(): void;
declare function ipc(method: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown>;

// Named constants — fine.
setTimeout(fn, DEFAULT_TIMEOUT_MS);
setInterval(fn, DEFAULT_POLL_INTERVAL_MS);
AbortSignal.timeout(ABORT_TIMEOUT_MS);
void ipc("listTools", {}, { timeoutMs: DEFAULT_TIMEOUT_MS });

// Literal 0 — explicit next-tick scheduling, allowed.
setTimeout(fn, 0);
setTimeout(() => fn(), 0);

// Non-decimal zero forms still evaluate to 0 — allowed (counterpart to the
// flagged-fixture hex/oct/bin cases, where the real value is non-zero).
setTimeout(fn, 0x0);
setTimeout(fn, 0o0);
setTimeout(fn, 0b0);
setTimeout(fn, 0_000);

// Bare numeric literals NOT in a timeout context — must not be matched.
const port = 19275;
const max = 100;
const arr = [1, 2, 3];
const obj = { retries: 3, count: 5000, intervalSeconds: 30 };
const sliced = arr.slice(0, 2);
console.log(port, max, sliced, obj);

// `timeout` / `timeoutMs` keys with non-literal values — allowed.
void ipc("listTools", {}, { timeoutMs: DEFAULT_TIMEOUT_MS + 1_000 });

// Methods named `setTimeout` on unrelated objects, but with named constant — allowed.
declare const conn: { setTimeout: (ms: number) => void };
conn.setTimeout(DEFAULT_TIMEOUT_MS);
