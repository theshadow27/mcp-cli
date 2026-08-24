/**
 * Concrete (no fakes) spec exercising the guard in `source.ts`.
 *
 * Named `.concrete.ts`, not `.spec.ts` — deliberately NOT picked up by the
 * repo-wide `bun test` glob (see bunfig.toml / default Bun test matching).
 * It only runs when the harness passes its path explicitly, mirroring how
 * `scripts/rules/fixtures/*.fixture.ts` stays invisible to normal test
 * discovery. Used only by `scripts/guards/harness.spec.ts`.
 */
import { describe, expect, test } from "bun:test";

import { NonPositiveAmountError, chargeAccount } from "./source";

describe("chargeAccount (fixture)", () => {
  test("rejects a non-positive amount", () => {
    expect(() => chargeAccount(100, -5)).toThrow(NonPositiveAmountError);
  });

  test("deducts a positive amount from the balance", () => {
    expect(chargeAccount(100, 30)).toBe(70);
  });
});
