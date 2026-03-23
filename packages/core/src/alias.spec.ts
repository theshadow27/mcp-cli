import { describe, expect, test } from "bun:test";
import { DEFINE_ALIAS_SENTINEL, extractContent, isDefineAlias } from "./alias";

describe("DEFINE_ALIAS_SENTINEL", () => {
  test("is the expected string", () => {
    expect(DEFINE_ALIAS_SENTINEL).toBe("defineAlias(");
  });
});

describe("isDefineAlias", () => {
  test("detects defineAlias call", () => {
    const source = 'defineAlias(({ z }) => ({ name: "test", fn: () => "ok" }));';
    expect(isDefineAlias(source)).toBe(true);
  });

  test("detects defineAlias with import statement", () => {
    const source = 'import { defineAlias } from "mcp-cli";\ndefineAlias({ name: "test" });';
    expect(isDefineAlias(source)).toBe(true);
  });

  test("returns false for freeform scripts", () => {
    const source = 'import { mcp } from "mcp-cli";\nconsole.log("hello");';
    expect(isDefineAlias(source)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isDefineAlias("")).toBe(false);
  });

  test("detects defineAlias even in comments (known false positive)", () => {
    expect(isDefineAlias("// defineAlias( is not a real call")).toBe(true);
  });

  test("returns false for partial match without open paren", () => {
    expect(isDefineAlias("const defineAlias = 42")).toBe(false);
  });
});

describe("extractContent", () => {
  test("unwraps single text content with JSON parsing", () => {
    const result = { content: [{ type: "text", text: '{"id":1,"name":"test"}' }] };
    expect(extractContent(result)).toEqual({ id: 1, name: "test" });
  });

  test("unwraps single text content as plain string when not JSON", () => {
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

  test("filters out non-text content items", () => {
    const result = {
      content: [
        { type: "image", text: "ignored" },
        { type: "text", text: "only text" },
      ],
    };
    expect(extractContent(result)).toEqual(["only text"]);
  });

  test("passes through non-MCP values unchanged", () => {
    expect(extractContent("raw string")).toBe("raw string");
    expect(extractContent(42)).toBe(42);
    expect(extractContent(null)).toBe(null);
    expect(extractContent(undefined)).toBe(undefined);
  });

  test("handles content without text field", () => {
    const result = { content: [{ type: "text" }] };
    expect(extractContent(result)).toEqual([]);
  });

  test("handles empty content array", () => {
    const result = { content: [] };
    expect(extractContent(result)).toEqual([]);
  });

  test("auto-parses Python repr text when JSON.parse fails", () => {
    const result = {
      content: [{ type: "text", text: "{'key': 'value', 'active': True}" }],
    };
    expect(extractContent(result)).toEqual({ key: "value", active: true });
  });

  test("auto-parses Python repr with nested JSON strings (Coralogix)", () => {
    const pythonRepr = `{'records': [{'user_data': '{"r":{"tid":"abc123"}}'}]}`;
    const result = { content: [{ type: "text", text: pythonRepr }] };
    expect(extractContent(result)).toEqual({
      records: [{ user_data: '{"r":{"tid":"abc123"}}' }],
    });
  });

  test("returns raw text when neither JSON nor Python repr", () => {
    const result = { content: [{ type: "text", text: "just plain text" }] };
    expect(extractContent(result)).toBe("just plain text");
  });
});
