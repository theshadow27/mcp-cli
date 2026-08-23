/**
 * Self-test fixture for the guard-reachability harness (#3212).
 *
 * A minimal, real guard: `chargeAccount` refuses a non-positive amount. The
 * sibling `source.concrete.ts` spec actually calls the path that trips the
 * guard, so mutating it out must break that spec — this is the REACHABLE
 * case (see `harness.spec.ts`).
 */

export class NonPositiveAmountError extends Error {}

export function assertPositiveAmount(amount: number): void {
  if (amount <= 0) {
    throw new NonPositiveAmountError(`amount must be positive, got ${amount}`);
  }
}

export function chargeAccount(balance: number, amount: number): number {
  assertPositiveAmount(amount);
  return balance - amount;
}
