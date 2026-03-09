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

/** A span in a W3C-compatible trace. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
}

/**
 * Create a child span from an incoming traceparent string, or a root span if
 * the input is absent or invalid.
 */
export function createSpan(parentTraceparent?: string): Span {
  const spanId = generateSpanId();
  if (!parentTraceparent) {
    return { traceId: generateTraceId(), spanId, traceFlags: TRACE_FLAGS_SAMPLED };
  }
  const parsed = parseTraceparent(parentTraceparent);
  if (!parsed) {
    return { traceId: generateTraceId(), spanId, traceFlags: TRACE_FLAGS_SAMPLED };
  }
  return { traceId: parsed.traceId, spanId, parentSpanId: parsed.parentId, traceFlags: parsed.flags };
}

/** Create a child span from an existing Span (avoids string round-trip). */
export function childSpan(parent: Span): Span {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    traceFlags: parent.traceFlags,
  };
}

/** Format a Span as a W3C traceparent string for downstream propagation. */
export function spanToTraceparent(span: Span): string {
  return formatTraceparent(span.traceId, span.spanId, span.traceFlags);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
