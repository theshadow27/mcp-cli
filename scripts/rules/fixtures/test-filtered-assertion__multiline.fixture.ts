/**
 * @rule test-filtered-assertion
 * @expect 2
 * @path packages/core/src/example.spec.ts
 *
 * Prettier-wrapped multi-line chains must also be flagged.
 */

import { expect, it } from "bun:test";

declare const warnings: string[];

it("multi-line toHaveLength", () => {
  expect(
    warnings.filter((w) => w.includes("deprecated"))
  ).toHaveLength(0);
});

it("multi-line toEqual", () => {
  expect(
    warnings.filter((w) =>
      w.startsWith("warn:")
    )
  ).toEqual([]);
});
