/**
 * @rule test-unguarded-narrowing
 * @expect 1
 * @path packages/daemon/src/example.spec.ts
 *
 * Discriminant assert inside the if-guard is vacuous — the assertion is
 * guarded by the same condition it claims to verify. If the wrong variant
 * is returned, the whole block is skipped including the assertion.
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

it("assert inside guard is still vacuous", () => {
  const result = getResult();
  if (result.kind === "ok") {
    expect(result.kind).toBe("ok");
    expect(result.value).toBe(42);
  }
});
