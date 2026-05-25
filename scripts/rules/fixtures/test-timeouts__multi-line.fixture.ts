/**
 * @rule test-timeouts
 * @expect 2
 * @path packages/daemon/src/example-multi-line.spec.ts
 *
 * Multi-line setTimeout and Bun.sleep calls — paren-depth tracking
 * must catch these.
 */

declare function fn(): void;

async function run(): Promise<void> {
  await new Promise<void>((r) =>
    setTimeout(
      r,
      50,
    ),
  );
  await Bun.sleep(
    100
  );
}

void run();
