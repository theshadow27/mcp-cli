/**
 * @rule named-timeouts
 * @expect 11
 * @path packages/daemon/src/example-timeouts-bad.ts
 *
 * Each numeric literal below is a magic number sitting at a timeout/delay
 * call site where a named *_MS constant should govern it.
 */

declare function fn(): void;
declare function ipc(method: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown>;
declare function exec(cmd: string, opts: { timeout: number }): void;

// setTimeout / setInterval — numeric literal in the delay position.
setTimeout(fn, 30000);
setTimeout(() => fn(), 5_000);
setInterval(fn, 3000);

// AbortSignal.timeout — sole numeric-literal argument.
const signal = AbortSignal.timeout(5000);
void signal;

// `timeoutMs` option-property — numeric literal value.
void ipc("listTools", {}, { timeoutMs: 5000 });

// `timeout` option-property — numeric literal value (e.g. spawnSync options).
exec("git status", { timeout: 10_000 });

// Nested `timeoutMs` literal inside a deeper option object.
void ipc("call", { wrapper: { timeoutMs: 2000 } as unknown }, { timeoutMs: 1_000 });

// Non-decimal forms: hex / octal / binary — each is a real non-zero delay
// (0x1F4 = 500ms, 0o7720 = 4048ms, 0b1111101000 = 1000ms). `parseFloat`
// stops at the `x`/`o`/`b` and silently returns 0, which would wrongly
// exempt these as "next tick". The rule must evaluate the real value.
setTimeout(fn, 0x1f4);
AbortSignal.timeout(0o7720);
void ipc("listTools", {}, { timeoutMs: 0b1111101000 });
