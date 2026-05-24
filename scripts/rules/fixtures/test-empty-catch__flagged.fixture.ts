/**
 * @rule test-empty-catch
 * @expect 2
 * @path packages/daemon/src/example.spec.ts
 *
 * Two catch blocks with no expect() inside — both should be flagged.
 */

import { describe, it } from "bun:test";

describe("empty catch", () => {
  it("swallows error silently", () => {
    try {
      JSON.parse("not json");
    } catch (e) {
      // oops, forgot to assert
    }
  });

  it("also swallows", () => {
    try {
      throw new Error("boom");
    } catch {
      console.log("caught");
    }
  });
});
