/**
 * @rule timer-callback-error-boundary
 * @expect 0
 * @path packages/daemon/src/example-timers.ts
 *
 * Safe timer patterns: safeSetTimeout, safeSetInterval, callbacks
 * whose body is fully wrapped in try/catch, function references,
 * Promise-constructor reject/resolve timeouts, and expression-bodied
 * arrows inside Promise constructors.
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

// Promise-race reject timeout — clean (inside new Promise constructor)
const racePromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("timeout")), 3000);
});

// Promise-constructor with block-body callback — clean
const anotherPromise = new Promise<string>((resolve, reject) => {
  setTimeout(() => {
    if (done) resolve("ok");
    else reject(new Error("timed out"));
  }, 5000);
});

// Expression-bodied arrow inside Promise constructor — clean
const thirdPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("deadline exceeded")), 10000);
});
