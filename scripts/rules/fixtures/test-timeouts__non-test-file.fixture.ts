/**
 * @rule test-timeouts
 * @expect 0
 * @path packages/daemon/src/example-prod.ts
 *
 * Same patterns as the flagged fixture, but the @path is production
 * code (not *.spec.ts) — the rule's appliesToTests: true must skip
 * these so production code is allowed to call setTimeout/Bun.sleep
 * with fixed delays.
 */

declare function fn(): void;

async function run(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 50));
  await Bun.sleep(100);
}

void run();
