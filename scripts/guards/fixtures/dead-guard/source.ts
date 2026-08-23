/**
 * Self-test fixture for the guard-reachability harness (#3212).
 *
 * A guard that exists in source but is never reached by the sibling
 * `source.concrete.ts` spec — mutating it out must NOT break anything. This
 * is the exact vacuous-check failure mode the harness exists to catch: the
 * guard *looks* covered (it's in the file the spec imports), but nothing in
 * the concrete spec set actually calls the guarded path. This is the "red"
 * bypass fixture proving the harness actually fires (@expect: DEAD).
 */

export function assertPositiveAmount(amount: number): void {
  if (amount <= 0) {
    throw new Error(`amount must be positive, got ${amount}`);
  }
}

export function describeAmount(amount: number): string {
  // BUG (deliberate, for the fixture): callers never invoke the guard above
  // on this path — describeAmount is fully independent of it.
  return `amount=${amount}`;
}
