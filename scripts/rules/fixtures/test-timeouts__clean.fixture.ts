/**
 * @rule test-timeouts
 * @expect 0
 * @path packages/daemon/src/example-clean.spec.ts
 *
 * All clean shapes: named-constant delays, single-arg setTimeout,
 * clearTimeout, template-literal Bun.sleep, and poll helpers.
 */

declare function fn(): void;
declare function pollUntil(p: () => boolean, opts: { timeout: number }): Promise<void>;
declare const POLL_INTERVAL: number;
declare const TIMEOUT: number;
declare const intervalMs: number;
declare const remaining: number;
declare function condition(): boolean;
declare function waitForMsg(): Promise<unknown>;

async function run(): Promise<void> {
  // Named constants are fine.
  setTimeout(fn, POLL_INTERVAL);
  setTimeout(fn, TIMEOUT);
  setTimeout(fn, TIMEOUT, 50); // 3-arg with named constant delay

  // Single-arg setTimeout has no delay parameter.
  setTimeout(fn);
  setTimeout(fn);

  // clearTimeout is not setTimeout.
  clearTimeout(0 as unknown as ReturnType<typeof setTimeout>);

  // Word-boundary: nosetTimeout and someTimeout are not setTimeout.
  // someTimeout(fn, 50);

  // Poll helpers.
  await pollUntil(() => condition(), { timeout: 5000 });

  // Bun.sleep with named/parameter delay.
  await Bun.sleep(intervalMs);
  await Bun.sleep(remaining);
  await Promise.race([waitForMsg(), Bun.sleep(remaining).then(() => null)]);
  // Template literal is not a numeric literal.
  await Bun.sleep(Number(`${intervalMs}`));
}

void run();
