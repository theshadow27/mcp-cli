import { describe, expect, test } from "bun:test";
import {
  TRACE_FLAGS_SAMPLED,
  TRACE_VERSION,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
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
