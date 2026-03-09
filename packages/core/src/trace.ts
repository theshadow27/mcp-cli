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

// -- Span lifecycle --

/** Span status codes (subset of OpenTelemetry). */
export type SpanStatus = "UNSET" | "OK" | "ERROR";

/** A timestamped annotation on a span. */
export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes?: Record<string, string | number | boolean>;
}

/** A finished, immutable span ready for recording/export. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

/** A live, in-progress span that can accumulate data and be ended. */
export interface LiveSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly traceFlags: string;
  readonly name: string;
  readonly startTimeMs: number;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(status: SpanStatus): void;
  /** End the span, returning the finished immutable Span. */
  end(): Span;
  /** Create a child span inheriting this span's trace context. */
  child(name: string): LiveSpan;
  /** Format as W3C traceparent string (this span's spanId becomes the parent). */
  traceparent(): string;
}

/**
 * Start a new span. If parentTraceparent is provided, inherits traceId and
 * records parentSpanId. If absent or invalid, creates a root span.
 *
 * @param onFallback - Optional callback invoked when parentTraceparent is
 *   present but invalid, causing a root span to be created instead. Use for
 *   metrics (e.g. incrementing mcpd_trace_fallback_root_total).
 */
export function startSpan(name: string, parentTraceparent?: string, onFallback?: () => void): LiveSpan {
  let traceId: string;
  let parentSpanId: string | undefined;
  let traceFlags = TRACE_FLAGS_SAMPLED;

  if (parentTraceparent) {
    const parsed = parseTraceparent(parentTraceparent);
    if (parsed) {
      traceId = parsed.traceId;
      parentSpanId = parsed.parentId;
      traceFlags = parsed.flags;
    } else {
      console.error("[trace] invalid traceparent, starting root span", { name, input: parentTraceparent });
      onFallback?.();
      traceId = generateTraceId();
    }
  } else {
    traceId = generateTraceId();
  }

  return createLiveSpan(name, traceId, generateSpanId(), parentSpanId, traceFlags);
}

function createLiveSpan(
  name: string,
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  traceFlags: string,
): LiveSpan {
  const startTimeMs = Date.now();
  const attributes: Record<string, string | number | boolean> = {};
  const events: SpanEvent[] = [];
  let status: SpanStatus = "UNSET";
  let ended = false;
  let frozenSpan: Span | undefined;

  return {
    get traceId() {
      return traceId;
    },
    get spanId() {
      return spanId;
    },
    get parentSpanId() {
      return parentSpanId;
    },
    get traceFlags() {
      return traceFlags;
    },
    get name() {
      return name;
    },
    get startTimeMs() {
      return startTimeMs;
    },

    setAttribute(key: string, value: string | number | boolean): void {
      if (!ended) attributes[key] = value;
    },

    addEvent(eventName: string, attrs?: Record<string, string | number | boolean>): void {
      if (!ended) events.push({ name: eventName, timeMs: Date.now(), attributes: attrs });
    },

    setStatus(s: SpanStatus): void {
      if (!ended) status = s;
    },

    end(): Span {
      if (ended && frozenSpan) {
        return frozenSpan;
      }
      ended = true;
      const endTimeMs = Date.now();
      frozenSpan = {
        traceId,
        spanId,
        parentSpanId,
        traceFlags,
        name,
        startTimeMs,
        endTimeMs,
        durationMs: endTimeMs - startTimeMs,
        status,
        attributes: { ...attributes },
        events: [...events],
      };
      return frozenSpan;
    },

    child(childName: string): LiveSpan {
      return createLiveSpan(childName, traceId, generateSpanId(), spanId, traceFlags);
    },

    traceparent(): string {
      return formatTraceparent(traceId, spanId, traceFlags);
    },
  };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
