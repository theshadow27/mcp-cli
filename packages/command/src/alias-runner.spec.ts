import { describe, expect, test } from "bun:test";
import { extractContent } from "./alias-runner.js";

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
