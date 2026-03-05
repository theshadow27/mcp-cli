import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { extractContent, formatAliasOutput, parseAliasInput } from "./alias-runner";

describe("extractContent", () => {
  test("unwraps single text content to parsed JSON", () => {
    const result = { content: [{ type: "text", text: '{"id": 1, "name": "test"}' }] };
    expect(extractContent(result)).toEqual({ id: 1, name: "test" });
  });

  test("unwraps single text content to raw string if not JSON", () => {
    const result = { content: [{ type: "text", text: "hello world" }] };
    expect(extractContent(result)).toBe("hello world");
  });

  test("returns array of text for multiple content items", () => {
    const result = {
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    expect(extractContent(result)).toEqual(["line 1", "line 2"]);
  });

  test("filters non-text content items in multi-item response", () => {
    const result = {
      content: [
        { type: "image", text: undefined },
        { type: "text", text: "only text" },
      ],
    };
    expect(extractContent(result)).toEqual(["only text"]);
  });

  test("passes through non-MCP results unchanged", () => {
    expect(extractContent("raw string")).toBe("raw string");
    expect(extractContent(42)).toBe(42);
    expect(extractContent(null)).toBe(null);
    expect(extractContent(undefined)).toBe(undefined);
  });

  test("passes through objects without content field", () => {
    const result = { data: "something" };
    expect(extractContent(result)).toEqual({ data: "something" });
  });

  test("handles empty content array", () => {
    const result = { content: [] };
    expect(extractContent(result)).toEqual([]);
  });

  test("handles single text content with empty text", () => {
    // content[0].text is empty string — falsy, so falls through to array path
    const result = { content: [{ type: "text", text: "" }] };
    expect(extractContent(result)).toEqual([""]);
  });
});

describe("parseAliasInput", () => {
  test("parses JSON input through object schema", () => {
    const schema = z.object({ email: z.string(), count: z.number() });
    const result = parseAliasInput(schema, '{"email":"a@b.com","count":5}', {});
    expect(result).toEqual({ email: "a@b.com", count: 5 });
  });

  test("parses JSON string input through string schema", () => {
    const schema = z.string();
    const result = parseAliasInput(schema, '"hello world"', {});
    expect(result).toBe("hello world");
  });

  test("parses JSON number input through number schema", () => {
    const schema = z.number();
    const result = parseAliasInput(schema, "42", {});
    expect(result).toBe(42);
  });

  test("falls back to cliArgs when no JSON input", () => {
    const schema = z.object({ name: z.string() });
    const result = parseAliasInput(schema, undefined, { name: "alice" });
    expect(result).toEqual({ name: "alice" });
  });

  test("returns undefined when no schema and no input", () => {
    expect(parseAliasInput(undefined, undefined, {})).toBeUndefined();
  });

  test("returns parsed JSON when no schema", () => {
    expect(parseAliasInput(undefined, '{"key":"val"}', {})).toEqual({ key: "val" });
  });

  test("treats non-JSON input as plain string", () => {
    const schema = z.string();
    const result = parseAliasInput(schema, "not-json", {});
    expect(result).toBe("not-json");
  });

  test("throws on schema validation failure", () => {
    const schema = z.object({ email: z.string().email() });
    expect(() => parseAliasInput(schema, '{"email":"not-an-email"}', {})).toThrow("Input validation failed");
  });

  test("returns cliArgs as object when no JSON and no schema", () => {
    expect(parseAliasInput(undefined, undefined, { key: "val" })).toEqual({ key: "val" });
  });
});

describe("formatAliasOutput", () => {
  test("returns undefined for null", () => {
    expect(formatAliasOutput(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(formatAliasOutput(undefined)).toBeUndefined();
  });

  test("returns raw string for string output", () => {
    expect(formatAliasOutput("hello")).toBe("hello");
  });

  test("returns JSON for object output", () => {
    expect(formatAliasOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("returns JSON for array output", () => {
    expect(formatAliasOutput([1, 2, 3])).toBe("[\n  1,\n  2,\n  3\n]");
  });

  test("returns JSON for number output", () => {
    expect(formatAliasOutput(42)).toBe("42");
  });

  test("returns JSON for boolean output", () => {
    expect(formatAliasOutput(true)).toBe("true");
  });
});
