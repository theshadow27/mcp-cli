/**
 * @rule test-unguarded-narrowing
 * @expect 0
 * @path packages/daemon/src/example.spec.ts
 *
 * Discriminant asserted with toStrictEqual before narrowing — correct pattern.
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

it("asserts discriminant with toStrictEqual before narrowing", () => {
  const result = getResult();
  expect(result.kind).toStrictEqual("ok");
  if (result.kind === "ok") {
    expect(result.value).toBe(42);
  }
});
