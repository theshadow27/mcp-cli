/**
 * Safe error introspection helpers.
 *
 * Use these for display/logging only. For control flow, branch on
 * `instanceof TypedError` or a structured `code` field — never on
 * message text.
 */

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // Common thrown-object shape: { message: string }
  if (err !== null && typeof err === "object" && "message" in err) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  // String() can throw for null-prototype objects (Object.create(null)) or
  // objects whose toString() throws. Fall back to the always-safe tag string.
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err) as string;
  }
}

export function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
