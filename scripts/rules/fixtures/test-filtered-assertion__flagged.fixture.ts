/**
 * @rule test-filtered-assertion
 * @expect 2
 * @path packages/core/src/example.spec.ts
 *
 * Two filtered-then-empty assertions — both should be flagged.
 */

import { expect, it } from "bun:test";

declare const warnings: string[];

it("hides unexpected warnings", () => {
  expect(warnings.filter(w => w.includes("deprecated"))).toHaveLength(0);
});

it("also hides with toEqual", () => {
  expect(warnings.filter(w => w.startsWith("warn:"))).toEqual([]);
});
