/**
 * @rule test-unguarded-narrowing
 * @expect 1
 * @path packages/daemon/src/example.spec.ts
 *
 * expect() inside an if-guard on a discriminant property, without first
 * asserting the discriminant. If the variant changes, the block is
 * silently skipped and the test passes vacuously.
 */

import { expect, it } from "bun:test";

interface OkResult {
  kind: "ok";
  value: number;
}
interface ErrResult {
  kind: "error";
  message: string;
}
type Result = OkResult | ErrResult;

declare function getResult(): Result;

it("checks sub-field without asserting discriminant", () => {
  const result = getResult();
  if (result.kind === "ok") {
    expect(result.value).toBe(42);
  }
});
