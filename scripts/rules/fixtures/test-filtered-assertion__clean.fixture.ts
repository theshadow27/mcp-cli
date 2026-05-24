/**
 * @rule test-filtered-assertion
 * @expect 0
 * @path packages/core/src/example.spec.ts
 *
 * Asserting the whole collection is the correct pattern.
 */

import { expect, it } from "bun:test";

declare const warnings: string[];

it("asserts the whole collection", () => {
  expect(warnings).toEqual([]);
});

it("filter with non-zero length is fine", () => {
  expect(warnings.filter(w => w.includes("expected"))).toHaveLength(2);
});
