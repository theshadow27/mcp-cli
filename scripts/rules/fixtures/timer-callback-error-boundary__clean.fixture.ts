/**
 * @rule timer-callback-error-boundary
 * @expect 0
 * @path packages/daemon/src/example-timers.ts
 *
 * Safe timer patterns: safeSetTimeout, safeSetInterval, callbacks
 * whose body is a try/catch (catchClause required — try-finally alone is NOT safe),
 * function references, and expression-bodied arrows that are a direct identifier
 * call inside Promise constructors (e.g. () => reject(...) / () => resolve(...)).
 *
 * Promise-constructor exemption is narrow: only plain identifier calls are safe
 * (reject/resolve themselves cannot throw). Method calls or other expressions
 * inside Promise constructors are still flagged.
 */

// safeSetTimeout — not setTimeout/setInterval, so not matched
safeSetTimeout(() => {
  doSomethingRisky();
}, 1000);

// safeSetInterval — same
safeSetInterval(async () => {
  await pollStatus();
}, 5000);

// Manual try/catch wrapping — clean
setTimeout(() => {
  try {
    doSomethingRisky();
  } catch (e) {
    console.error(e);
  }
}, 1000);

// Async callback with try/catch — clean
setInterval(async () => {
  try {
    await doAsyncWork();
  } catch (e) {
    console.error(e);
  }
}, 2000);

// Function reference (not inline callback) — clean (can't inspect body)
setTimeout(handleStuckEvent, 5000);

// Promise-race reject timeout — expression-bodied arrow inside Promise constructor, clean
const racePromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("timeout")), 3000);
});

// Promise-constructor resolve — expression-bodied arrow, clean
const resolvePromise = new Promise<void>((resolve) => {
  setTimeout(() => resolve(), 500);
});

// Expression-bodied arrow inside Promise constructor — clean
const thirdPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("deadline exceeded")), 10000);
});
