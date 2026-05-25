/**
 * @rule test-timeouts
 * @expect 5
 * @path packages/daemon/src/example.spec.ts
 *
 * Five flagged patterns across setTimeout and Bun.sleep:
 *   1. setTimeout(fn, 50) — bare numeric
 *   2. setTimeout(() => r(null), 50) — arrow-callback with nested paren
 *   3. setTimeout(fn, 50, extra) — 3-arg form: delay is arg[1], not last
 *   4. await Bun.sleep(100) — single numeric
 *   5. Bun.sleep(1_000) — underscore separator
 */

declare function fn(): void;

async function run(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 50));
  await new Promise<null>((r) => setTimeout(() => r(null), 50));
  setTimeout(fn, 50, undefined);
  await Bun.sleep(100);
  await Bun.sleep(1_000);
}

void run();
