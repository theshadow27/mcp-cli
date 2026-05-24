import { describe, expect, it } from "bun:test";
import { ToolResultError, unwrapToolResult, unwrapToolResultJson } from "./mcp-result";

describe("unwrapToolResult", () => {
  it("returns text from a successful result", () => {
    const result = { content: [{ type: "text", text: "hello" }] };
    expect(unwrapToolResult(result)).toBe("hello");
  });

  it("throws ToolResultError when isError is true", () => {
    const result = { content: [{ type: "text", text: "something broke" }], isError: true };
    expect(() => unwrapToolResult(result)).toThrow(ToolResultError);
    expect(() => unwrapToolResult(result)).toThrow("something broke");
  });

  it("uses fallback message when error result has no content", () => {
    const result = { content: [], isError: true };
    expect(() => unwrapToolResult(result)).toThrow("Unknown MCP tool error");
  });

  it("throws when result has no text content block", () => {
    const result = { content: [{ type: "image", text: "" }] };
    expect(() => unwrapToolResult(result)).toThrow("no text content");
  });

  it("throws when result is null", () => {
    expect(() => unwrapToolResult(null)).toThrow("no text content");
  });

  it("joins multiple text blocks with newline", () => {
    const result = {
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    expect(unwrapToolResult(result)).toBe("line 1\nline 2");
  });

  it("joins multiple text blocks in error message", () => {
    const result = {
      content: [
        { type: "text", text: "Error A" },
        { type: "text", text: "Error B" },
      ],
      isError: true,
    };
    expect(() => unwrapToolResult(result)).toThrow("Error A\nError B");
  });

  it("ToolResultError has correct name", () => {
    try {
      unwrapToolResult({ content: [{ type: "text", text: "fail" }], isError: true });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolResultError);
      expect((e as ToolResultError).name).toBe("ToolResultError");
    }
  });
});

describe("unwrapToolResultJson", () => {
  it("parses valid JSON from a successful result", () => {
    const result = { content: [{ type: "text", text: '{"key":"value"}' }] };
    expect(unwrapToolResultJson<{ key: string }>(result)).toEqual({ key: "value" });
  });

  it("parses JSON arrays", () => {
    const result = { content: [{ type: "text", text: "[1,2,3]" }] };
    expect(unwrapToolResultJson<number[]>(result)).toEqual([1, 2, 3]);
  });

  it("throws ToolResultError on invalid JSON", () => {
    const result = { content: [{ type: "text", text: "not json" }] };
    expect(() => unwrapToolResultJson(result)).toThrow(ToolResultError);
    expect(() => unwrapToolResultJson(result)).toThrow("Failed to parse");
  });

  it("throws ToolResultError when isError is true (before parsing)", () => {
    const result = { content: [{ type: "text", text: '{"valid":"json"}' }], isError: true };
    expect(() => unwrapToolResultJson(result)).toThrow(ToolResultError);
  });

  it("uses only the first text block for JSON parsing when multiple blocks present", () => {
    const result = {
      content: [
        { type: "text", text: '{"a":1}' },
        { type: "text", text: '{"b":2}' },
      ],
    };
    expect(unwrapToolResultJson<{ a: number }>(result)).toEqual({ a: 1 });
  });

  it("throws ToolResultError with cause on invalid JSON", () => {
    const result = { content: [{ type: "text", text: "not json" }] };
    try {
      unwrapToolResultJson(result);
      throw new Error("should not reach");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolResultError);
      expect((e as ToolResultError).cause).toBeInstanceOf(SyntaxError);
    }
  });
});
