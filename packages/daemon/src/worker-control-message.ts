/**
 * Shared control-message guard for worker files.
 *
 * Worker postMessage channels carry both JSON-RPC messages (with `jsonrpc`)
 * and control messages (with `type`). This module provides a reusable type
 * guard to distinguish them without duplicating logic across workers.
 */

/** A control message has a string `type` field from a known allowlist. */
export interface ControlMessageBase {
  type: string;
}

/**
 * Creates a type guard that checks whether `data` is a control message
 * whose `type` is in the provided allowlist.
 */
export function createIsControlMessage<T extends ControlMessageBase>(
  validTypes: ReadonlySet<string>,
): (data: unknown) => data is T {
  return (data: unknown): data is T =>
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as Record<string, unknown>).type === "string" &&
    validTypes.has((data as Record<string, unknown>).type as string);
}
