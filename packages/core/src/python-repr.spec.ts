import { describe, expect, it } from "bun:test";
import { parsePythonRepr, pythonReprToJson } from "./python-repr";

describe("pythonReprToJson", () => {
  it("converts single-quoted strings to double-quoted", () => {
    expect(pythonReprToJson("{'key': 'value'}")).toBe('{"key": "value"}');
  });

  it("converts True/False/None to JSON equivalents", () => {
    expect(pythonReprToJson("{'a': True, 'b': False, 'c': None}")).toBe('{"a": true, "b": false, "c": null}');
  });

  it("handles double-quoted strings (passthrough)", () => {
    expect(pythonReprToJson('{"key": "value"}')).toBe('{"key": "value"}');
  });

  it("handles embedded double quotes inside single-quoted strings", () => {
    const input = `{'msg': 'say "hello"'}`;
    const result = pythonReprToJson(input);
    expect(JSON.parse(result)).toEqual({ msg: 'say "hello"' });
  });

  it("handles embedded apostrophes via escaped single quotes", () => {
    const input = `{'msg': 'it\\'s broken'}`;
    const result = pythonReprToJson(input);
    expect(JSON.parse(result)).toEqual({ msg: "it's broken" });
  });

  it("converts Python tuples to arrays", () => {
    expect(pythonReprToJson("('a', 'b', 'c')")).toBe('["a", "b", "c"]');
  });

  it("handles trailing comma in tuples", () => {
    const result = pythonReprToJson("('single',)");
    expect(JSON.parse(result)).toEqual(["single"]);
  });

  it("handles nested structures", () => {
    const input = "{'users': [{'name': 'Alice', 'active': True}, {'name': 'Bob', 'active': False}]}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({
      users: [
        { name: "Alice", active: true },
        { name: "Bob", active: false },
      ],
    });
  });

  it("handles numeric values", () => {
    const input = "{'count': 42, 'rate': 3.14, 'neg': -1}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ count: 42, rate: 3.14, neg: -1 });
  });

  it("handles escape sequences in strings", () => {
    const input = "{'path': 'C:\\\\Users\\\\test', 'line': 'hello\\nworld'}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ path: "C:\\Users\\test", line: "hello\nworld" });
  });
});

describe("parsePythonRepr", () => {
  it("returns non-string values unchanged", () => {
    expect(parsePythonRepr(42)).toBe(42);
    expect(parsePythonRepr(null)).toBe(null);
    expect(parsePythonRepr(undefined)).toBe(undefined);
    const obj = { a: 1 };
    expect(parsePythonRepr(obj)).toBe(obj);
  });

  it("parses valid JSON without conversion", () => {
    expect(parsePythonRepr('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("parses Python repr dict", () => {
    expect(parsePythonRepr("{'key': 'value'}")).toEqual({ key: "value" });
  });

  it("parses Python repr with keywords", () => {
    expect(parsePythonRepr("{'active': True, 'deleted': False, 'data': None}")).toEqual({
      active: true,
      deleted: false,
      data: null,
    });
  });

  it("handles the Coralogix-style result from the issue", () => {
    const input = "{'results': [{'severity': 'warning', 'count': 5, 'resolved': False}], 'total': 1, 'has_more': True}";
    expect(parsePythonRepr(input)).toEqual({
      results: [{ severity: "warning", count: 5, resolved: false }],
      total: 1,
      has_more: true,
    });
  });

  it("returns original string on unparseable input", () => {
    expect(parsePythonRepr("not a dict at all")).toBe("not a dict at all");
  });

  it("returns empty string unchanged", () => {
    expect(parsePythonRepr("")).toBe("");
  });

  it("handles mixed quote styles in values", () => {
    const input = `{'msg': "it's broken"}`;
    expect(parsePythonRepr(input)).toEqual({ msg: "it's broken" });
  });
});
