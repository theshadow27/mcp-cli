import { afterEach, describe, expect, test } from "bun:test";
import { _resetJqStateForTesting } from "./index";
import { SERVE_SIZE_OK, SERVE_SIZE_TRUNCATE, extractJqArg, injectJqParam, processJqResult } from "./jq-support";

// -- Constants --

describe("serve size thresholds", () => {
  test("SERVE_SIZE_OK is 8KB", () => {
    expect(SERVE_SIZE_OK).toBe(8 * 1024);
  });

  test("SERVE_SIZE_TRUNCATE is 15KB", () => {
    expect(SERVE_SIZE_TRUNCATE).toBe(15 * 1024);
  });
});

// -- injectJqParam --

describe("injectJqParam", () => {
  test("adds jq property to schema with existing properties", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const result = injectJqParam(schema);
    expect(result.properties).toHaveProperty("jq");
    expect(result.properties).toHaveProperty("q");
  });

  test("adds jq property to schema with no properties", () => {
    const schema = { type: "object" };
    const result = injectJqParam(schema);
    expect((result.properties as Record<string, unknown>).jq).toBeDefined();
  });

  test("does not mutate the original schema", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const original = JSON.parse(JSON.stringify(schema));
    injectJqParam(schema);
    expect(schema).toEqual(original);
  });

  test("preserves other schema fields", () => {
    const schema = { type: "object", properties: {}, required: ["q"] };
    const result = injectJqParam(schema);
    expect(result.required).toEqual(["q"]);
    expect(result.type).toBe("object");
  });
});

// -- extractJqArg --

describe("extractJqArg", () => {
  test("extracts jq filter from args", () => {
    const { jqFilter, cleanArgs } = extractJqArg({ q: "test", jq: ".items[:5]" });
    expect(jqFilter).toBe(".items[:5]");
    expect(cleanArgs).toEqual({ q: "test" });
  });

  test("returns undefined filter when jq not present", () => {
    const { jqFilter, cleanArgs } = extractJqArg({ q: "test" });
    expect(jqFilter).toBeUndefined();
    expect(cleanArgs).toEqual({ q: "test" });
  });

  test("returns undefined filter for non-string jq values", () => {
    const { jqFilter, cleanArgs } = extractJqArg({ jq: 123 });
    expect(jqFilter).toBeUndefined();
    expect(cleanArgs).toEqual({});
  });

  test("handles empty args", () => {
    const { jqFilter, cleanArgs } = extractJqArg({});
    expect(jqFilter).toBeUndefined();
    expect(cleanArgs).toEqual({});
  });

  test("handles jq='false' as a string", () => {
    const { jqFilter } = extractJqArg({ jq: "false" });
    expect(jqFilter).toBe("false");
  });
});

// -- processJqResult --

function makeResult(
  text: string,
  isError?: boolean,
): { isError?: boolean; content: Array<{ type: string; text: string }> } {
  return { ...(isError !== undefined ? { isError } : {}), content: [{ type: "text", text }] };
}

function makeJsonResult(data: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("processJqResult", () => {
  afterEach(() => {
    _resetJqStateForTesting();
  });

  // -- Error passthrough --

  test("passes through error results unchanged", async () => {
    const result = makeResult("something broke", true);
    const processed = await processJqResult(result, ".foo");
    expect(processed).toEqual(result);
  });

  // -- jq='false' bypass --

  test("jq='false' bypasses all processing", async () => {
    const bigText = "x".repeat(20 * 1024);
    const result = makeResult(bigText);
    const processed = await processJqResult(result, "false");
    expect(processed.content[0].text).toBe(bigText);
  });

  // -- Size protection (no jq filter) --

  test("small responses pass through unchanged", async () => {
    const result = makeResult("small response");
    const processed = await processJqResult(result, undefined);
    expect(processed).toEqual(result);
  });

  test("medium JSON responses get a size hint appended", async () => {
    const data = {
      items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, desc: `description-${i}-padding` })),
    };
    const text = JSON.stringify(data);
    // Ensure it's in the medium range (8KB-15KB)
    expect(Buffer.byteLength(text)).toBeGreaterThan(SERVE_SIZE_OK);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SERVE_SIZE_TRUNCATE);
    const result = makeResult(text);
    const processed = await processJqResult(result, undefined);
    // Original content preserved + hint appended
    expect(processed.content.length).toBeGreaterThan(1);
    const lastItem = processed.content[processed.content.length - 1];
    expect(lastItem.text).toContain("[mcx]");
    expect(lastItem.text).toContain("jq");
  });

  test("large JSON responses get structural analysis", async () => {
    const data = { records: Array.from({ length: 500 }, (_, i) => ({ id: i, payload: "x".repeat(50) })) };
    const text = JSON.stringify(data);
    expect(Buffer.byteLength(text)).toBeGreaterThan(SERVE_SIZE_TRUNCATE);
    const result = makeResult(text);
    const processed = await processJqResult(result, undefined);
    expect(processed.content[0].text).toContain("Response too large");
    expect(processed.content[0].text).toContain("jq parameter");
  });

  test("large non-JSON responses get truncated with preview", async () => {
    const bigText = "Not JSON! ".repeat(2000);
    expect(Buffer.byteLength(bigText)).toBeGreaterThan(SERVE_SIZE_TRUNCATE);
    const result = makeResult(bigText);
    const processed = await processJqResult(result, undefined);
    expect(processed.content[0].text).toContain("non-JSON");
    expect(processed.content[0].text).toContain("Preview:");
    expect(processed.content[0].text).toContain("[truncated]");
  });

  test("medium non-JSON responses pass through unchanged", async () => {
    // Generate a non-JSON string between 8KB and 15KB
    const text = "plain text ".repeat(1000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(SERVE_SIZE_OK);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SERVE_SIZE_TRUNCATE);
    const result = makeResult(text);
    const processed = await processJqResult(result, undefined);
    expect(processed).toEqual(result);
  });

  // -- Explicit jq filter --

  test("applies jq filter to JSON response", async () => {
    const data = { items: [1, 2, 3] };
    const result = makeJsonResult(data);
    const processed = await processJqResult(result, ".items");
    const parsed = JSON.parse(processed.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  test("jq filter on non-JSON returns error", async () => {
    const result = makeResult("not json");
    const processed = await processJqResult(result, ".items");
    expect(processed.isError).toBe(true);
    expect(processed.content[0].text).toContain("not valid JSON");
  });

  test("jq unavailable returns error with bypass hint", async () => {
    _resetJqStateForTesting("WASM not available");
    const result = makeJsonResult({ x: 1 });
    const processed = await processJqResult(result, ".x");
    expect(processed.isError).toBe(true);
    expect(processed.content[0].text).toContain("jq unavailable");
    expect(processed.content[0].text).toContain("jq='false'");
  });

  test("invalid jq filter returns error", async () => {
    const result = makeJsonResult({ x: 1 });
    // Invalid jq syntax — should produce an error from jq-web
    const processed = await processJqResult(result, "invalid[[[");
    expect(processed.isError).toBe(true);
    expect(processed.content[0].text).toContain("jq filter error");
  });
});
