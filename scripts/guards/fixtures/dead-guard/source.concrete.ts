/**
 * Concrete (no fakes) spec for `source.ts` that never exercises
 * `assertPositiveAmount` — see the file comment there. Used only by
 * `scripts/guards/harness.spec.ts`.
 */
import { describe, expect, test } from "bun:test";

import { describeAmount } from "./source";

describe("describeAmount (fixture)", () => {
  test("formats the amount", () => {
    expect(describeAmount(42)).toBe("amount=42");
  });
});
