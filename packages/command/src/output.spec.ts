import { describe, expect, test } from "bun:test";
import { formatToolResult } from "./output.js";

describe("formatToolResult", () => {
  test("returns empty string for null", () => {
    expect(formatToolResult(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(formatToolResult(undefined)).toBe("");
  });

  test("formats MCP content array with text", () => {
    const result = {
      content: [{ type: "text", text: '{"key":"value"}' }],
    };
    expect(formatToolResult(result)).toBe('{\n  "key": "value"\n}');
  });

  test("formats non-JSON text as-is", () => {
    const result = {
      content: [{ type: "text", text: "plain text response" }],
    };
    expect(formatToolResult(result)).toBe("plain text response");
  });

  test("formats multiple content items", () => {
    const result = {
      content: [
        { type: "text", text: '{"a":1}' },
        { type: "text", text: '{"b":2}' },
      ],
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('"a": 1');
    expect(formatted).toContain('"b": 2');
  });

  test("formats non-text content items as JSON", () => {
    const result = {
      content: [{ type: "image", data: "base64..." }],
    };
    const formatted = formatToolResult(result);
    expect(formatted).toContain('"type": "image"');
  });

  test("formats plain object as JSON", () => {
    const result = { foo: "bar" };
    expect(formatToolResult(result)).toBe('{\n  "foo": "bar"\n}');
  });
});
