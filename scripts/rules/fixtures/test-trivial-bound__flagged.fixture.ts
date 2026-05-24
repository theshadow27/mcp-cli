/**
 * @rule test-trivial-bound
 * @expect 1
 * @path packages/daemon/src/example.spec.ts
 *
 * toBeLessThanOrEqual(1) passes at 0 — should be flagged.
 */

import { expect, it } from "bun:test";

declare const callCount: number;

it("at most once — passes when never called", () => {
  expect(callCount).toBeLessThanOrEqual(1);
});
