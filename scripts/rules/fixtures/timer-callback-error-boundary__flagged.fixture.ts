/**
 * @rule timer-callback-error-boundary
 * @expect 4
 * @path packages/daemon/src/example-timers-bad.ts
 *
 * Bare callbacks in setTimeout/setInterval with no catch boundary:
 * - async block body with no try/catch
 * - expression-bodied arrow outside Promise constructor
 * - try-finally without catch (exception still escapes the finally)
 * - non-identifier expression body inside Promise constructor
 */

// Block-body async callback with no try/catch — flagged
setTimeout(async () => {
  await doThing();
}, 5000);

// Expression-bodied arrow outside Promise constructor — flagged
setTimeout(() => riskyCall(), 1000);

// try-finally without catch — exception escapes after finally runs — flagged
setTimeout(() => {
  try {
    riskyOperation();
  } finally {
    cleanup();
  }
}, 1000);

// Non-identifier expression body inside Promise constructor — flagged
// Only plain identifier calls like () => reject(...) are exempt.
const p = new Promise<void>((resolve) => {
  setTimeout(() => obj.doRiskyThing(), 500);
});
