/**
 * Safe error introspection helpers.
 *
 * Use these for display/logging only. For control flow, branch on
 * `instanceof TypedError` or a structured `code` field — never on
 * message text.
 */

export function getErrorMessage(err: unknown): string {
  // Entire body is inside try/catch: Proxy has/get traps and throwing getters
  // must not escape — this function is called from catch blocks and must never
  // itself throw.
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    // Common thrown-object shape: { message: string }
    if (err !== null && typeof err === "object" && "message" in err) {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
    return String(err);
  } catch {
    // Object.prototype.toString can also throw (e.g. throwing @@toStringTag getter).
    try {
      return Object.prototype.toString.call(err) as string;
    } catch {
      return "[unprintable error]";
    }
  }
}

/**
 * Extracts a `.code` field from an error-like value.
 *
 * Returns the code as-is when it is a `string` or `number` (Node.js system
 * errors and `IpcCallError` use numeric codes). Returns `undefined` for any
 * other type, or when the field is absent.
 *
 * Use for control flow only when the code is a known stable contract. For
 * display/logging use `getErrorMessage` instead.
 */
export function getErrorCode(err: unknown): string | number | undefined {
  try {
    if (err !== null && typeof err === "object" && "code" in err) {
      const code = (err as Record<string, unknown>).code;
      if (typeof code === "string" || typeof code === "number") return code;
    }
  } catch {
    // Proxy has/get traps and throwing .code getters must not escape.
  }
  return undefined;
}
