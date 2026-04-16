import { afterEach, describe, expect, test } from "bun:test";
import {
  JqUnavailableError,
  SIZE_HINT,
  SIZE_OK,
  _resetJqStateForTesting,
  analyzeStructure,
  applyJqFilter,
  generateAnalysis,
  jqParseErrorHints,
} from "./index";

describe("applyJqFilter", () => {
  afterEach(() => {
    _resetJqStateForTesting();
  });

  test("throws JqUnavailableError when WASM is marked unavailable", async () => {
    _resetJqStateForTesting("test: WASM not loaded");
    await expect(applyJqFilter({ a: 1 }, ".a")).rejects.toBeInstanceOf(JqUnavailableError);
  });

  test("JqUnavailableError contains reason", async () => {
    _resetJqStateForTesting("missing binary");
    try {
      await applyJqFilter({}, ".");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JqUnavailableError);
      expect((err as Error).message).toContain("missing binary");
    }
  });
});

describe("constants", () => {
  test("SIZE_OK is 10KB", () => {
    expect(SIZE_OK).toBe(10 * 1024);
  });

  test("SIZE_HINT is 20KB", () => {
    expect(SIZE_HINT).toBe(20 * 1024);
  });
});

describe("analyzeStructure", () => {
  test("analyzes flat object", () => {
    const paths = analyzeStructure({ name: "Alice", age: 30 });
    expect(paths.get("name")).toMatchObject({ type: "string", count: 1 });
    expect(paths.get("age")).toMatchObject({ type: "number", count: 1 });
  });

  test("analyzes array of objects", () => {
    const data = [
      { id: "a", name: "X" },
      { id: "b", name: "Y" },
    ];
    const paths = analyzeStructure(data);
    expect(paths.get("[].id")).toMatchObject({ type: "string", count: 2 });
    expect(paths.get("[].name")).toMatchObject({ type: "string", count: 2 });
  });

  test("collects up to 3 samples", () => {
    const data = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
    const paths = analyzeStructure(data);
    const stats = paths.get("[].v");
    expect(stats).toBeDefined();
    expect(stats?.samples).toHaveLength(3);
    expect(stats?.count).toBe(4);
  });

  test("handles null values", () => {
    const paths = analyzeStructure({ x: null });
    expect(paths.get("x")).toMatchObject({ type: "null", count: 1 });
  });

  test("handles empty arrays", () => {
    const paths = analyzeStructure({ items: [] });
    expect(paths.get("items")).toMatchObject({ type: "array", count: 1 });
  });

  test("handles nested objects", () => {
    const paths = analyzeStructure({ a: { b: { c: 42 } } });
    expect(paths.get("a.b.c")).toMatchObject({ type: "number", count: 1 });
  });
});

describe("jqParseErrorHints", () => {
  test("returns hints for truncated server response", () => {
    const text = "Response too large (81.8KB). Structure analysis:\n\n  entities[].contacts: array";
    const hints = jqParseErrorHints(text);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain("--jq filter requires JSON");
    expect(hints[0]).toContain("Response too large");
    expect(hints[1]).toContain("raw:true");
    expect(hints[1]).toContain("server-side jq");
  });

  test("truncates long previews to 120 chars", () => {
    const text = "x".repeat(200);
    const hints = jqParseErrorHints(text);
    expect(hints[0]).toContain(`"${"x".repeat(120)}..."`);
  });

  test("replaces newlines in preview", () => {
    const text = "line1\nline2\nline3";
    const hints = jqParseErrorHints(text);
    expect(hints[0]).toContain("line1 line2 line3");
    expect(hints[0]).not.toContain("\n");
  });
});

describe("generateAnalysis", () => {
  test("includes size in header", () => {
    const data = [{ id: "1", name: "Test" }];
    const analysis = generateAnalysis(data, 25 * 1024);
    expect(analysis).toContain("Response too large (25.0KB)");
  });

  test("includes structure paths", () => {
    const data = [
      { id: "tbl1", name: "Table1" },
      { id: "tbl2", name: "Table2" },
    ];
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain("[].id: string");
    expect(analysis).toContain("[].name: string");
  });

  test("includes suggested jq filters for arrays with nested arrays", () => {
    const data = [
      { id: "1", tags: ["a", "b"] },
      { id: "2", tags: ["c"] },
    ];
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain("Suggested jq filters:");
    // Nested arrays produce paths ending in [] (e.g., [].tags[])
    expect(analysis).toContain("[:5]");
    expect(analysis).toContain("| keys");
    expect(analysis).toContain("| length");
  });

  test("includes suggested jq filters for flat arrays", () => {
    const data = [{ id: "1" }, { id: "2" }];
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain("Suggested jq filters:");
    // Flat arrays of objects fall through to the object branch
    expect(analysis).toContain("keys");
    expect(analysis).toContain("to_entries[:5]");
  });

  test("includes suggested jq filters for objects", () => {
    const data = { foo: 1, bar: 2, baz: 3 };
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain("keys");
    expect(analysis).toContain("to_entries[:5]");
  });

  test("marks heavy paths", () => {
    // Create data where one field dominates byte count
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      payload: "x".repeat(1000),
    }));
    const analysis = generateAnalysis(items, 30 * 1024);
    expect(analysis).toContain("[heavy]");
  });

  test("shows sample values", () => {
    const data = [{ name: "Alice" }, { name: "Bob" }];
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain('"Alice"');
    expect(analysis).toContain('"Bob"');
  });

  test("includes footer with --jq and --full hints", () => {
    const data = [{ id: "1" }];
    const analysis = generateAnalysis(data, 30 * 1024);
    expect(analysis).toContain("Use --jq '<filter>' to filter, or --full for raw output.");
  });
});
