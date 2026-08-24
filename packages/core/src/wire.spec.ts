import { describe, expect, test } from "bun:test";
import { MAX_WIRE_DEPTH, WireUnsafeError, assertWireSafe, findWireUnsafeValue, isWireSafe } from "./wire";

describe("findWireUnsafeValue", () => {
  test("accepts every JSON shape", () => {
    for (const value of [
      null,
      "",
      "text",
      0,
      -1.5,
      true,
      false,
      [],
      {},
      [1, "two", null, { three: [true] }],
      { nested: { deep: { deeper: [{ ok: 1 }] } } },
    ]) {
      expect(findWireUnsafeValue(value)).toBeNull();
    }
  });

  test("rejects the values structured clone carries but JSON does not", () => {
    // These are the trap: postMessage delivers them intact today, so code
    // written against them works right up until the link becomes a socket.
    const cases: Array<[unknown, string]> = [
      [new Date(), "Date"],
      [new Map([["a", 1]]), "Map"],
      [new Set([1]), "Set"],
      [/re/, "RegExp"],
      [new Uint8Array([1, 2]), "Uint8Array"],
    ];
    for (const [value, name] of cases) {
      const problem = findWireUnsafeValue({ field: value });
      expect(problem).toContain("$.field");
      expect(problem).toContain(name);
    }
  });

  test("rejects undefined, functions, symbols and bigint", () => {
    expect(findWireUnsafeValue({ a: undefined })).toContain("undefined");
    expect(findWireUnsafeValue({ a: () => 1 })).toContain("function");
    expect(findWireUnsafeValue({ a: Symbol("s") })).toContain("symbol");
    expect(findWireUnsafeValue({ a: 1n })).toContain("bigint");
  });

  test("rejects numbers that JSON turns into null", () => {
    expect(findWireUnsafeValue(Number.NaN)).toContain("NaN");
    expect(findWireUnsafeValue({ a: Number.POSITIVE_INFINITY })).toContain("Infinity");
    expect(findWireUnsafeValue({ a: Number.NEGATIVE_INFINITY })).toContain("Infinity");
  });

  test("rejects class instances even when every field is JSON-safe", () => {
    class Payload {
      constructor(readonly value = 1) {}
    }
    expect(findWireUnsafeValue(new Payload())).toContain("Payload");
  });

  test("accepts a null-prototype object", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(findWireUnsafeValue(bare)).toBeNull();
  });

  test("rejects symbol-keyed properties, which JSON drops silently", () => {
    expect(findWireUnsafeValue({ [Symbol("hidden")]: 1, visible: 2 })).toContain("symbol-keyed");
  });

  test("rejects cycles rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(findWireUnsafeValue(cyclic)).toContain("circular");

    const viaArray: unknown[] = [];
    viaArray.push(viaArray);
    expect(findWireUnsafeValue(viaArray)).toContain("circular");
  });

  test("allows the same object to appear twice — a DAG is not a cycle", () => {
    const shared = { a: 1 };
    expect(findWireUnsafeValue({ left: shared, right: shared })).toBeNull();
  });

  test("rejects a structure deeper than the depth limit", () => {
    let deep: unknown = 1;
    for (let i = 0; i <= MAX_WIRE_DEPTH + 1; i++) deep = { deep };
    expect(findWireUnsafeValue(deep)).toContain("deeper than");
  });

  test("names the path to the offending value", () => {
    expect(findWireUnsafeValue({ outer: { list: [1, new Date()] } })).toContain("$.outer.list[1]");
  });

  test("reports the first problem, not a partial answer", () => {
    expect(findWireUnsafeValue([undefined])).toContain("$[0]");
  });
});

describe("assertWireSafe", () => {
  test("returns the value it was given", () => {
    const message = { type: "init", n: 1 };
    expect(assertWireSafe(message, "test")).toBe(message);
  });

  test("throws a WireUnsafeError naming the context and the reason", () => {
    const offending = { when: new Date() };
    expect(() => assertWireSafe(offending, "domain init")).toThrow(WireUnsafeError);
    try {
      assertWireSafe(offending, "domain init");
    } catch (err) {
      expect((err as WireUnsafeError).message).toContain("domain init");
      expect((err as WireUnsafeError).detail).toContain("$.when");
    }
  });
});

describe("isWireSafe", () => {
  test("agrees with an actual JSON round trip", () => {
    for (const value of [{ a: [1, "2", null] }, "x", 3, true, null, []]) {
      expect(isWireSafe(value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    // The converse: everything it rejects really does change shape (or throw)
    // when JSON handles it.
    expect(isWireSafe({ a: new Date(0) })).toBe(false);
    expect(JSON.parse(JSON.stringify({ a: new Date(0) })).a).toBe("1970-01-01T00:00:00.000Z");
    expect(isWireSafe({ a: new Map() })).toBe(false);
    expect(JSON.parse(JSON.stringify({ a: new Map([["k", 1]]) }))).toEqual({ a: {} });
    expect(isWireSafe({ a: undefined })).toBe(false);
    expect(Object.hasOwn(JSON.parse(JSON.stringify({ a: undefined })), "a")).toBe(false);
  });
});
