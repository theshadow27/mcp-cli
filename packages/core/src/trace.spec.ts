import { describe, expect, test } from "bun:test";
import {
  TRACE_FLAGS_SAMPLED,
  TRACE_VERSION,
  childSpan,
  createSpan,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  spanToTraceparent,
} from "./trace";

const HEX_RE = /^[0-9a-f]+$/;

describe("generateTraceId", () => {
  test("returns 32 lowercase hex chars", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(HEX_RE.test(id)).toBe(true);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSpanId", () => {
  test("returns 16 lowercase hex chars", () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(HEX_RE.test(id)).toBe(true);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
    expect(ids.size).toBe(100);
  });
});

describe("formatTraceparent", () => {
  test("produces W3C format", () => {
    const traceId = "a".repeat(32);
    const parentId = "b".repeat(16);
    const result = formatTraceparent(traceId, parentId);
    expect(result).toBe(`${TRACE_VERSION}-${"a".repeat(32)}-${"b".repeat(16)}-${TRACE_FLAGS_SAMPLED}`);
  });

  test("accepts custom flags", () => {
    const result = formatTraceparent("a".repeat(32), "b".repeat(16), "00");
    expect(result).toEndWith("-00");
  });
});

describe("parseTraceparent", () => {
  test("round-trips with formatTraceparent", () => {
    const traceId = generateTraceId();
    const parentId = generateSpanId();
    const header = formatTraceparent(traceId, parentId);
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({
      version: TRACE_VERSION,
      traceId,
      parentId,
      flags: TRACE_FLAGS_SAMPLED,
    });
  });

  test("returns null for wrong segment count", () => {
    expect(parseTraceparent("00-abc-def")).toBeNull();
    expect(parseTraceparent("00-abc-def-01-extra")).toBeNull();
  });

  test("returns null for wrong trace ID length", () => {
    expect(parseTraceparent(`00-${"a".repeat(31)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(33)}-${"b".repeat(16)}-01`)).toBeNull();
  });

  test("returns null for wrong parent ID length", () => {
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(15)}-01`)).toBeNull();
  });

  test("returns null for non-hex characters", () => {
    expect(parseTraceparent(`00-${"G".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"Z".repeat(16)}-01`)).toBeNull();
  });

  test("returns null for wrong version/flags length", () => {
    expect(parseTraceparent(`0-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-1`)).toBeNull();
  });
});

describe("createSpan", () => {
  test("no parent creates root span with sampled flag", () => {
    const span = createSpan();
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.traceFlags).toBe(TRACE_FLAGS_SAMPLED);
  });

  test("valid parent creates child span with same traceId", () => {
    const traceId = generateTraceId();
    const parentSpanId = generateSpanId();
    const tp = formatTraceparent(traceId, parentSpanId);

    const span = createSpan(tp);
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toHaveLength(16);
    expect(span.spanId).not.toBe(parentSpanId);
    expect(span.parentSpanId).toBe(parentSpanId);
    expect(span.traceFlags).toBe(TRACE_FLAGS_SAMPLED);
  });

  test("preserves parent traceFlags", () => {
    const traceId = generateTraceId();
    const parentSpanId = generateSpanId();
    const tp = formatTraceparent(traceId, parentSpanId, "00");

    const span = createSpan(tp);
    expect(span.traceFlags).toBe("00");
  });

  test("invalid parent creates root span", () => {
    const span = createSpan("garbage");
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.parentSpanId).toBeUndefined();
  });

  test("undefined parent creates root span", () => {
    const span = createSpan(undefined);
    expect(span.parentSpanId).toBeUndefined();
  });
});

describe("spanToTraceparent", () => {
  test("formats as W3C traceparent preserving flags", () => {
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: "01" };
    expect(spanToTraceparent(span)).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);

    const unsampled = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: "00" };
    expect(spanToTraceparent(unsampled)).toEndWith("-00");
  });

  test("round-trips through createSpan", () => {
    const parent = createSpan();
    const parentTp = spanToTraceparent(parent);
    const child = createSpan(parentTp);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  test("multi-hop chain preserves traceId", () => {
    const root = createSpan();
    const mid = createSpan(spanToTraceparent(root));
    const leaf = createSpan(spanToTraceparent(mid));

    expect(mid.traceId).toBe(root.traceId);
    expect(leaf.traceId).toBe(root.traceId);
    expect(leaf.parentSpanId).toBe(mid.spanId);
    expect(mid.parentSpanId).toBe(root.spanId);
  });
});

describe("childSpan", () => {
  test("creates child with same traceId and flags", () => {
    const parent = createSpan();
    const child = childSpan(parent);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.traceFlags).toBe(parent.traceFlags);
  });

  test("propagates non-sampled flags", () => {
    const tp = formatTraceparent(generateTraceId(), generateSpanId(), "00");
    const parent = createSpan(tp);
    const child = childSpan(parent);

    expect(child.traceFlags).toBe("00");
  });

  test("multi-hop chain via childSpan", () => {
    const root = createSpan();
    const mid = childSpan(root);
    const leaf = childSpan(mid);

    expect(leaf.traceId).toBe(root.traceId);
    expect(leaf.parentSpanId).toBe(mid.spanId);
    expect(mid.parentSpanId).toBe(root.spanId);
  });
});
