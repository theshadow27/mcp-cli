import { describe, expect, mock, test } from "bun:test";
import type { AliasDetail } from "@mcp-cli/core";
import { extractErrorMessage, formatToolResult, printAliasDebug, printAliasList, printToolList } from "./output";

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

  test("formats Python repr as JSON", () => {
    const result = {
      content: [{ type: "text", text: "{'records': [{'user_data': '{\"errors\":6}'}], 'dataprime_warnings': []}" }],
    };
    const formatted = formatToolResult(result);
    const parsed = JSON.parse(formatted);
    expect(parsed).toEqual({ records: [{ user_data: '{"errors":6}' }], dataprime_warnings: [] });
  });

  test("formats Python repr with True/False/None as JSON", () => {
    const result = {
      content: [{ type: "text", text: "{'active': True, 'deleted': False, 'data': None}" }],
    };
    const formatted = formatToolResult(result);
    const parsed = JSON.parse(formatted);
    expect(parsed).toEqual({ active: true, deleted: false, data: null });
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

describe("printAliasList", () => {
  function captureStdout(fn: () => void): string {
    const original = console.log;
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => lines.push(args.join(" ")));
    try {
      fn();
      return lines.join("\n");
    } finally {
      console.log = original;
    }
  }

  const defineAliasEntry = {
    name: "my-tool",
    description: "Look up a user",
    filePath: "/tmp/my-tool.ts",
    updatedAt: 0,
    aliasType: "defineAlias" as const,
  };

  const freeformEntry = {
    name: "old-script",
    description: "Legacy script",
    filePath: "/tmp/old-script.ts",
    updatedAt: 0,
    aliasType: "freeform" as const,
  };

  test("shows defineAlias type indicator", () => {
    const output = captureStdout(() => printAliasList([defineAliasEntry]));
    expect(output).toContain("defineAlias");
    expect(output).toContain("my-tool");
    expect(output).toContain("Look up a user");
  });

  test("shows freeform type indicator", () => {
    const output = captureStdout(() => printAliasList([freeformEntry]));
    expect(output).toContain("freeform");
    expect(output).toContain("old-script");
    expect(output).toContain("Legacy script");
  });

  test("shows both types in mixed list", () => {
    const output = captureStdout(() => printAliasList([defineAliasEntry, freeformEntry]));
    expect(output).toContain("defineAlias");
    expect(output).toContain("freeform");
    expect(output).toContain("2 alias(es)");
  });

  test("shows empty message when no aliases", () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = mock((...args: unknown[]) => lines.push(args.join(" ")));
    try {
      printAliasList([]);
      expect(lines.join("\n")).toContain("No aliases saved");
    } finally {
      console.error = original;
    }
  });

  test("shows ephemeral aliases separately with expiry", () => {
    const ephemeralEntry = {
      name: "get_-a83r",
      description: "ephemeral: server/tool",
      filePath: "/tmp/get_-a83r.ts",
      updatedAt: 0,
      aliasType: "freeform" as const,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000, // 2 hours from now
    };
    const output = captureStdout(() => printAliasList([freeformEntry, ephemeralEntry]));
    expect(output).toContain("Ephemeral");
    expect(output).toContain("get_-a83r");
    expect(output).toContain("expires");
    expect(output).toContain("1 ephemeral");
    expect(output).toContain("2 alias(es)");
  });

  test("permanent aliases not shown in ephemeral section", () => {
    const output = captureStdout(() => printAliasList([defineAliasEntry, freeformEntry]));
    expect(output).not.toContain("Ephemeral");
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

describe("printToolList ANSI-aware truncation", () => {
  function captureStdout(fn: () => void): string {
    const original = console.log;
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => lines.push(args.join(" ")));
    try {
      fn();
      return lines.join("\n");
    } finally {
      console.log = original;
    }
  }

  test("truncates long descriptions using Bun.sliceAnsi", () => {
    const longDesc = "A".repeat(100);
    const tools = [{ name: "tool1", server: "srv", description: longDesc }];
    const output = captureStdout(() => printToolList(tools));
    // Should be truncated to 77 chars + "..."
    expect(output).toContain(`${"A".repeat(77)}...`);
    expect(output).not.toContain("A".repeat(78));
  });

  test("preserves ANSI codes in truncated descriptions", () => {
    // Description with ANSI color that would break with naive .slice()
    const colored = `\x1b[32m${"A".repeat(100)}\x1b[0m`;
    const tools = [{ name: "tool1", server: "srv", description: colored }];
    const output = captureStdout(() => printToolList(tools));
    // Bun.sliceAnsi should preserve the opening SGR and add a reset
    expect(output).toContain("\x1b[32m");
    expect(output).toContain("...");
  });

  test("does not truncate short descriptions", () => {
    const tools = [{ name: "tool1", server: "srv", description: "short desc" }];
    const output = captureStdout(() => printToolList(tools));
    expect(output).toContain("short desc");
    expect(output).not.toContain("...");
  });
});

describe("extractErrorMessage", () => {
  test("returns message for regular Error", () => {
    expect(extractErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("returns String(err) for non-Error", () => {
    expect(extractErrorMessage("raw string")).toBe("raw string");
    expect(extractErrorMessage(42)).toBe("42");
  });

  test("returns stderr for ShellError-like object", () => {
    const err = new Error("Failed with exit code 254");
    Object.assign(err, {
      stderr: Buffer.from("An error occurred (InvalidParameterValue)\n"),
      exitCode: 254,
    });
    expect(extractErrorMessage(err)).toBe("An error occurred (InvalidParameterValue)");
  });

  test("falls back to message when stderr is empty", () => {
    const err = new Error("Failed with exit code 1");
    Object.assign(err, {
      stderr: Buffer.from(""),
      exitCode: 1,
    });
    expect(extractErrorMessage(err)).toBe("Failed with exit code 1");
  });

  test("falls back to message when stderr is whitespace-only", () => {
    const err = new Error("Failed with exit code 1");
    Object.assign(err, {
      stderr: Buffer.from("  \n  "),
      exitCode: 1,
    });
    expect(extractErrorMessage(err)).toBe("Failed with exit code 1");
  });
});
