/**
 * W3C Trace Context compatible ID generation and formatting.
 *
 * Provides trace-id (128-bit), span/parent-id (64-bit), and traceparent
 * header formatting per https://www.w3.org/TR/trace-context/.
 */

const HEX_REGEX = /^[0-9a-f]+$/;

/** Generate a 128-bit trace ID (32 lowercase hex chars). */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Generate a 64-bit span/parent ID (16 lowercase hex chars). */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** W3C traceparent version. */
export const TRACE_VERSION = "00";

/** Trace flags: sampled. */
export const TRACE_FLAGS_SAMPLED = "01";

/** Format a W3C traceparent header: `{version}-{traceId}-{parentId}-{flags}`. */
export function formatTraceparent(traceId: string, parentId: string, flags: string = TRACE_FLAGS_SAMPLED): string {
  return `${TRACE_VERSION}-${traceId}-${parentId}-${flags}`;
}

/** Parsed W3C traceparent components. */
export interface Traceparent {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
}

/** Parse a W3C traceparent string. Returns null if invalid. */
export function parseTraceparent(header: string): Traceparent | null {
  const parts = header.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (traceId.length !== 32 || parentId.length !== 16) return null;
  if (!HEX_REGEX.test(traceId) || !HEX_REGEX.test(parentId)) return null;
  if (version.length !== 2 || flags.length !== 2) return null;
  return { version, traceId, parentId, flags };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
