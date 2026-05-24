/**
 * @rule test-empty-catch
 * @expect 0
 * @path packages/daemon/src/example.spec.ts
 *
 * Catch blocks that contain expect() calls are fine — the error is asserted.
 */

import { describe, expect, it } from "bun:test";

describe("proper catch", () => {
  it("asserts the error", () => {
    try {
      JSON.parse("not json");
    } catch (e) {
      expect(e).toBeInstanceOf(SyntaxError);
    }
  });

  it("also uses expect().toThrow as alternative", () => {
    expect(() => JSON.parse("not json")).toThrow(SyntaxError);
  });
});
