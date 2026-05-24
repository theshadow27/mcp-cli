/**
 * @rule timer-callback-error-boundary
 * @expect 2
 * @path packages/daemon/src/example-timers-bad.ts
 *
 * Bare callbacks in setTimeout/setInterval with no try/catch and
 * not inside a Promise constructor — will produce unhandled
 * exceptions or rejections.
 */

// Block-body async callback with no try/catch — flagged
setTimeout(async () => {
  await doThing();
}, 5000);

// Expression-bodied arrow outside Promise constructor — flagged
setTimeout(() => riskyCall(), 1000);
