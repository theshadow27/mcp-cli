import { afterEach, describe, expect, test } from "bun:test";
import { checkDeprecatedName } from "./deprecation";
import { extractFullFlag, extractJqFlag, extractJsonFlag, extractTimeoutFlag } from "./parse";

describe("checkDeprecatedName", () => {
  let stderrOutput: string[] = [];
  const origError = console.error;

  afterEach(() => {
    console.error = origError;
    stderrOutput = [];
  });

  function captureStderr(): void {
    console.error = (...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    };
  }

  test("returns true and warns when invoked as 'mcp'", () => {
    captureStderr();
    expect(checkDeprecatedName("/usr/local/bin/mcp")).toBe(true);
    expect(stderrOutput.length).toBe(1);
    expect(stderrOutput[0]).toContain("renamed to");
    expect(stderrOutput[0]).toContain("mcx");
  });

  test("returns true for bare 'mcp' without path", () => {
    captureStderr();
    expect(checkDeprecatedName("mcp")).toBe(true);
    expect(stderrOutput.length).toBe(1);
  });

  test("returns true for mcp.exe on Windows", () => {
    captureStderr();
    expect(checkDeprecatedName("C:/bin/mcp.exe")).toBe(true);
    expect(stderrOutput.length).toBe(1);
  });

  test("returns false for 'mcx'", () => {
    captureStderr();
    expect(checkDeprecatedName("/usr/local/bin/mcx")).toBe(false);
    expect(stderrOutput.length).toBe(0);
  });

  test("returns false for 'mcpd'", () => {
    captureStderr();
    expect(checkDeprecatedName("/usr/local/bin/mcpd")).toBe(false);
    expect(stderrOutput.length).toBe(0);
  });

  test("returns false for 'mcpctl'", () => {
    captureStderr();
    expect(checkDeprecatedName("/usr/local/bin/mcpctl")).toBe(false);
    expect(stderrOutput.length).toBe(0);
  });

  test("returns false for empty string", () => {
    captureStderr();
    expect(checkDeprecatedName("")).toBe(false);
    expect(stderrOutput.length).toBe(0);
  });
});

describe("extractJsonFlag", () => {
  test("extracts -j flag", () => {
    expect(extractJsonFlag(["-j", "atlassian"])).toEqual({ json: true, rest: ["atlassian"] });
  });

  test("extracts --format json flag", () => {
    expect(extractJsonFlag(["atlassian", "--format", "json"])).toEqual({
      json: true,
      rest: ["atlassian"],
    });
  });

  test("returns json=false when no flag present", () => {
    expect(extractJsonFlag(["atlassian"])).toEqual({ json: false, rest: ["atlassian"] });
  });

  test("returns json=false for empty args", () => {
    expect(extractJsonFlag([])).toEqual({ json: false, rest: [] });
  });

  test("keeps --format without json value as-is", () => {
    expect(extractJsonFlag(["--format", "text"])).toEqual({ json: false, rest: ["--format", "text"] });
  });

  test("handles -j at end of args", () => {
    expect(extractJsonFlag(["atlassian", "search", "-j"])).toEqual({
      json: true,
      rest: ["atlassian", "search"],
    });
  });

  test("handles --format json in the middle of args", () => {
    expect(extractJsonFlag(["--format", "json", "atlassian"])).toEqual({
      json: true,
      rest: ["atlassian"],
    });
  });

  test("extracts --json flag", () => {
    expect(extractJsonFlag(["atlassian", "--json"])).toEqual({ json: true, rest: ["atlassian"] });
  });
});

describe("cmdCall flag extraction chain", () => {
  // Simulates the flag extraction chain used by cmdCall in main.ts.
  // Verifies that all known flags are stripped before positional arg parsing,
  // preventing flags like --json from contaminating @file paths (#1052).
  function extractCallFlags(args: string[]) {
    const { full, rest: afterFull } = extractFullFlag(args);
    const { jq: jqFilter, rest: afterJq } = extractJqFlag(afterFull);
    const { timeoutMs, rest: afterTimeout } = extractTimeoutFlag(afterJq);
    const { rest: afterJson } = extractJsonFlag(afterTimeout);
    return { full, jqFilter, timeoutMs, rest: afterJson };
  }

  test("--json after @file does not contaminate positional args", () => {
    const result = extractCallFlags(["server", "tool", "@/tmp/test.json", "--json"]);
    expect(result.rest).toEqual(["server", "tool", "@/tmp/test.json"]);
  });

  test("--json before positional args is stripped cleanly", () => {
    const result = extractCallFlags(["--json", "server", "tool", "@/tmp/test.json"]);
    expect(result.rest).toEqual(["server", "tool", "@/tmp/test.json"]);
  });

  test("multiple flags with @file are all stripped", () => {
    const result = extractCallFlags(["server", "tool", "@/tmp/data.json", "--json", "--full", "--timeout", "30"]);
    expect(result.rest).toEqual(["server", "tool", "@/tmp/data.json"]);
    expect(result.full).toBe(true);
    expect(result.timeoutMs).toBe(30_000);
  });

  test("--jq and --json together do not leak into rest", () => {
    const result = extractCallFlags(["server", "tool", "@/tmp/data.json", "--jq", ".foo", "--json"]);
    expect(result.rest).toEqual(["server", "tool", "@/tmp/data.json"]);
    expect(result.jqFilter).toBe(".foo");
  });
});
