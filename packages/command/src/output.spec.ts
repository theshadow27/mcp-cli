import { describe, expect, mock, test } from "bun:test";
import type { AliasDetail } from "@mcp-cli/core";
import { formatToolResult, printAliasDebug } from "./output.js";

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

describe("printAliasDebug", () => {
  function captureStderr(fn: () => void): string {
    const original = console.error;
    const lines: string[] = [];
    console.error = mock((...args: unknown[]) => lines.push(args.join(" ")));
    try {
      fn();
      return lines.join("\n");
    } finally {
      console.error = original;
    }
  }

  test("shows defineAlias header with description", () => {
    const alias: AliasDetail = {
      name: "my-tool",
      description: "Look up a user",
      filePath: "/home/user/.mcp-cli/aliases/my-tool.ts",
      updatedAt: 0,
      aliasType: "defineAlias",
      script: "defineAlias(() => ({}))",
    };
    const output = captureStderr(() => printAliasDebug(alias));
    expect(output).toContain("my-tool (defineAlias)");
    expect(output).toContain("description");
    expect(output).toContain("Look up a user");
    expect(output).toContain("source");
    expect(output).toContain(alias.filePath);
  });

  test("shows input/output schemas for defineAlias", () => {
    const alias: AliasDetail = {
      name: "my-tool",
      description: "Test",
      filePath: "/tmp/my-tool.ts",
      updatedAt: 0,
      aliasType: "defineAlias",
      script: "",
      inputSchemaJson: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
      outputSchemaJson: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    };
    const output = captureStderr(() => printAliasDebug(alias));
    expect(output).toContain("input");
    expect(output).toContain("email");
    expect(output).toContain("output");
    expect(output).toContain("id");
  });

  test("shows freeform header without schemas", () => {
    const alias: AliasDetail = {
      name: "old-script",
      description: "Legacy script",
      filePath: "/tmp/old-script.ts",
      updatedAt: 0,
      aliasType: "freeform",
      script: 'import { mcp } from "mcp-cli";',
    };
    const output = captureStderr(() => printAliasDebug(alias));
    expect(output).toContain("old-script (freeform)");
    expect(output).toContain("Legacy script");
    expect(output).not.toContain("input");
    expect(output).not.toContain("output");
  });

  test("omits description line when not set", () => {
    const alias: AliasDetail = {
      name: "nodesc",
      description: "",
      filePath: "/tmp/nodesc.ts",
      updatedAt: 0,
      aliasType: "freeform",
      script: "",
    };
    const output = captureStderr(() => printAliasDebug(alias));
    expect(output).not.toContain("description");
    expect(output).toContain("source");
  });
});
