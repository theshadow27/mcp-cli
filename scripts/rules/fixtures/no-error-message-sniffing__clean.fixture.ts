/**
 * @rule no-error-message-sniffing
 * @expect 0
 * @path packages/daemon/src/example-catches.ts
 *
 * Clean patterns: instanceof checks, getErrorMessage for display,
 * bare .message access in non-control-flow contexts, and .message.includes
 * stored as a value (not used directly as a condition).
 */

import { getErrorMessage } from "../../packages/core/src/errors";

class TimeoutError extends Error {
  override name = "TimeoutError" as const;
}

declare function log(msg: string): void;

export function goodControlFlow(err: unknown): string {
  // instanceof — the prescribed alternative to message sniffing
  if (err instanceof TimeoutError) {
    return "timed out";
  }
  // getErrorMessage for display, not control flow
  log(getErrorMessage(err));
  return "unknown";
}

export function displayOnly(err: unknown): void {
  // .message access for display — not in a control-flow condition
  if (err instanceof Error) {
    console.error("caught:", err.message);
  }
}

export function codeCheck(err: unknown): boolean {
  // Checking a structured code field, not the message text
  if (err !== null && typeof err === "object" && "code" in err) {
    return (err as { code: unknown }).code === "ECONNREFUSED";
  }
  return false;
}

export function ternaryOnInstance(err: unknown): string {
  // Ternary on instanceof — clean
  return err instanceof TimeoutError ? "timeout" : getErrorMessage(err);
}

export function valueNotCondition(err: unknown): void {
  // .message.includes used as a stored value, not directly as a condition
  // Rule fires only when the call result immediately drives control flow;
  // data-flow through a variable is out of scope.
  const hasDetail = err instanceof Error && err.message.includes("detail");
  log(String(hasDetail));
}

export function assignedInArrow(errors: Error[]): string[] {
  // .message.includes inside an arrow function body used as a filter predicate.
  // The predicate is an arrow function argument, not a bare control-flow condition.
  // This fires in practice and is flagged — but pure "store then use" is clean.
  return errors.filter((e) => e instanceof TimeoutError).map((e) => e.message);
}
