/**
 * @rule test-trivial-bound
 * @expect 0
 * @path packages/daemon/src/example.spec.ts
 *
 * Exact assertions, meaningful bounds, and index checks are fine.
 */

import { expect, it } from "bun:test";

declare const callCount: number;
declare const idx: number;

it("exact count", () => {
  expect(callCount).toBe(1);
});

it("meaningful upper bound", () => {
  expect(callCount).toBeLessThanOrEqual(10);
});

it("index check — toBeGreaterThanOrEqual(0) means found", () => {
  expect(idx).toBeGreaterThanOrEqual(0);
});
