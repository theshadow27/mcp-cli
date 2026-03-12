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

  it("handles \\x escapes in single-quoted strings", () => {
    const input = "{'name': 'caf\\xc3\\xa9'}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ name: "caf\u00c3\u00a9" });
  });

  it("handles \\U BMP escapes in single-quoted strings", () => {
    const input = "{'emoji': '\\U00000041'}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ emoji: "A" });
  });

  it("handles \\U astral plane escapes as surrogate pairs", () => {
    const input = "{'emoji': '\\U0001F600'}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ emoji: "\u{1F600}" });
  });

  it("handles \\0, \\a, \\v escapes", () => {
    const input = "{'bell': '\\a', 'vt': '\\v', 'null': '\\0'}";
    const result = JSON.parse(pythonReprToJson(input));
    expect(result).toEqual({ bell: "\u0007", vt: "\u000b", null: "\u0000" });
  });

  it("strips b'' prefix and parses byte string as regular string", () => {
    expect(pythonReprToJson("{'data': b'hello'}")).toBe('{"data": "hello"}');
  });

  it("strips B'' prefix (uppercase)", () => {
    expect(pythonReprToJson("B'hello'")).toBe('"hello"');
  });

  it("strips u'' prefix", () => {
    expect(pythonReprToJson("{'name': u'Alice'}")).toBe('{"name": "Alice"}');
  });

  it("strips f'' prefix", () => {
    expect(pythonReprToJson("f'formatted'")).toBe('"formatted"');
  });

  it("handles r'' raw string — backslashes are literal", () => {
    const result = pythonReprToJson("r'\\path\\to\\file'");
    expect(JSON.parse(result)).toBe("\\path\\to\\file");
  });

  it("handles r'' raw string with Windows path", () => {
    const result = pythonReprToJson("{'path': r'C:\\Users\\test\\file.txt'}");
    expect(JSON.parse(result)).toEqual({ path: "C:\\Users\\test\\file.txt" });
  });

  it("handles br'' two-character prefix", () => {
    expect(pythonReprToJson("br'hello'")).toBe('"hello"');
  });

  it("handles rb'' two-character prefix", () => {
    expect(pythonReprToJson("rb'hello'")).toBe('"hello"');
  });

  it("handles rb'' raw mode — backslashes literal", () => {
    const result = pythonReprToJson("rb'\\n\\t'");
    expect(JSON.parse(result)).toBe("\\n\\t");
  });

  it("handles prefix on double-quoted strings", () => {
    expect(pythonReprToJson('b"hello"')).toBe('"hello"');
  });

  it("handles r prefix on double-quoted strings", () => {
    const result = pythonReprToJson('r"C:\\Users\\test"');
    expect(JSON.parse(result)).toBe("C:\\Users\\test");
  });

  it("does not infinite loop on bare + or -", () => {
    const input = "{'a': +, 'b': -}";
    // Should complete without hanging — output may not be valid JSON
    // but must not loop forever
    const result = pythonReprToJson(input);
    expect(typeof result).toBe("string");
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

  it("parses dict with byte string values", () => {
    expect(parsePythonRepr("{'data': b'hello'}")).toEqual({ data: "hello" });
  });

  it("parses dict with raw string path", () => {
    expect(parsePythonRepr("{'path': r'C:\\Users\\test'}")).toEqual({ path: "C:\\Users\\test" });
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
