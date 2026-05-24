/**
 * @rule timer-callback-error-boundary
 * @expect 0
 * @path packages/daemon/src/example-timers.ts
 *
 * Safe timer patterns: safeSetTimeout, safeSetInterval, callbacks
 * whose body is fully wrapped in try/catch, function references,
 * and expression-bodied arrows inside Promise constructors.
 *
 * Note: only expression-bodied arrows are exempt inside Promise constructors.
 * Block-body callbacks are NOT exempt even inside new Promise() — the Promise
 * constructor's try/catch only covers synchronous executor code, not callbacks
 * scheduled by setTimeout/setInterval that fire after the constructor returns.
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
