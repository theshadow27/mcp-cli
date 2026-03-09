import { describe, expect, mock, test } from "bun:test";
import {
  TRACE_FLAGS_SAMPLED,
  TRACE_VERSION,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  startSpan,
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

// -- Span lifecycle tests --

describe("startSpan", () => {
  test("creates root span without parent", () => {
    const span = startSpan("test.root");
    expect(span.name).toBe("test.root");
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.traceFlags).toBe(TRACE_FLAGS_SAMPLED);
    expect(span.startTimeMs).toBeGreaterThan(0);
  });

  test("creates child span from valid traceparent", () => {
    const traceId = generateTraceId();
    const parentId = generateSpanId();
    const tp = formatTraceparent(traceId, parentId);

    const span = startSpan("test.child", tp);
    expect(span.traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentId);
    expect(span.spanId).not.toBe(parentId);
  });

  test("creates root span from invalid traceparent", () => {
    const span = startSpan("test.fallback", "garbage");
    expect(span.traceId).toHaveLength(32);
    expect(span.parentSpanId).toBeUndefined();
  });

  test("calls onFallback when traceparent is invalid", () => {
    const onFallback = mock();
    startSpan("test.fallback_cb", "garbage", onFallback);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test("does not call onFallback when traceparent is valid", () => {
    const onFallback = mock();
    const tp = formatTraceparent(generateTraceId(), generateSpanId());
    startSpan("test.no_fallback", tp, onFallback);
    expect(onFallback).toHaveBeenCalledTimes(0);
  });

  test("does not call onFallback when traceparent is absent", () => {
    const onFallback = mock();
    startSpan("test.no_parent", undefined, onFallback);
    expect(onFallback).toHaveBeenCalledTimes(0);
  });

  test("preserves trace flags from parent", () => {
    const tp = formatTraceparent(generateTraceId(), generateSpanId(), "00");
    const span = startSpan("test.flags", tp);
    expect(span.traceFlags).toBe("00");
  });
});

describe("LiveSpan", () => {
  test("end() returns finished Span with timing", () => {
    const live = startSpan("test.end");
    const finished = live.end();

    expect(finished.name).toBe("test.end");
    expect(finished.endTimeMs).toBeGreaterThanOrEqual(finished.startTimeMs);
    expect(finished.durationMs).toBe(finished.endTimeMs - finished.startTimeMs);
    expect(finished.status).toBe("UNSET");
    expect(finished.attributes).toEqual({});
    expect(finished.events).toEqual([]);
  });

  test("end() returns same object on repeated calls", () => {
    const live = startSpan("test.idempotent");
    const first = live.end();
    const second = live.end();
    expect(first).toBe(second);
  });

  test("setAttribute records attributes", () => {
    const live = startSpan("test.attrs");
    live.setAttribute("key", "value");
    live.setAttribute("count", 42);
    live.setAttribute("flag", true);

    const finished = live.end();
    expect(finished.attributes).toEqual({ key: "value", count: 42, flag: true });
  });

  test("setAttribute is no-op after end", () => {
    const live = startSpan("test.frozen");
    live.end();
    live.setAttribute("late", "value");
    expect(live.end().attributes).toEqual({});
  });

  test("setStatus records status", () => {
    const live = startSpan("test.status");
    live.setStatus("OK");
    expect(live.end().status).toBe("OK");
  });

  test("setStatus ERROR", () => {
    const live = startSpan("test.error");
    live.setStatus("ERROR");
    expect(live.end().status).toBe("ERROR");
  });

  test("addEvent records timestamped events", () => {
    const live = startSpan("test.events");
    live.addEvent("start_processing");
    live.addEvent("got_result", { rows: 5 });

    const finished = live.end();
    expect(finished.events).toHaveLength(2);
    expect(finished.events[0].name).toBe("start_processing");
    expect(finished.events[1].name).toBe("got_result");
    expect(finished.events[1].attributes).toEqual({ rows: 5 });
    expect(finished.events[0].timeMs).toBeGreaterThan(0);
  });

  test("addEvent is no-op after end", () => {
    const live = startSpan("test.frozen_events");
    live.end();
    live.addEvent("late");
    expect(live.end().events).toEqual([]);
  });

  test("child() creates span with same traceId", () => {
    const parent = startSpan("test.parent");
    const child = parent.child("test.child");

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.traceFlags).toBe(parent.traceFlags);
  });

  test("traceparent() formats as W3C string", () => {
    const live = startSpan("test.tp");
    const tp = live.traceparent();
    const parsed = parseTraceparent(tp);

    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe(live.traceId);
    expect(parsed?.parentId).toBe(live.spanId);
    expect(parsed?.flags).toBe(live.traceFlags);
  });

  test("multi-hop trace preserves traceId", () => {
    const root = startSpan("root");
    const mid = root.child("mid");
    const leaf = mid.child("leaf");

    expect(mid.traceId).toBe(root.traceId);
    expect(leaf.traceId).toBe(root.traceId);
    expect(leaf.parentSpanId).toBe(mid.spanId);
    expect(mid.parentSpanId).toBe(root.spanId);
  });

  test("end() snapshots attributes (mutations don't leak)", () => {
    const live = startSpan("test.snapshot");
    live.setAttribute("before", true);
    const finished = live.end();
    expect(finished.attributes).toEqual({ before: true });
    // The finished object should be a copy
    expect(Object.isFrozen(finished.attributes)).toBe(false);
  });
});
