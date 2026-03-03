import { describe, expect, test } from "bun:test";
import { parseLogsArgs } from "./logs.js";

describe("parseLogsArgs", () => {
  test("parses server name", () => {
    const result = parseLogsArgs(["myserver"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(false);
    expect(result.lines).toBe(50);
    expect(result.error).toBeUndefined();
  });

  test("parses -f flag", () => {
    const result = parseLogsArgs(["myserver", "-f"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(true);
  });

  test("parses --follow flag", () => {
    const result = parseLogsArgs(["myserver", "--follow"]);
    expect(result.follow).toBe(true);
  });

  test("parses --lines N", () => {
    const result = parseLogsArgs(["myserver", "--lines", "100"]);
    expect(result.lines).toBe(100);
  });

  test("parses -n as alias for --lines", () => {
    const result = parseLogsArgs(["myserver", "-n", "25"]);
    expect(result.lines).toBe(25);
  });

  test("returns error for --lines without value", () => {
    const result = parseLogsArgs(["myserver", "--lines"]);
    expect(result.error).toBe("--lines requires a number");
  });

  test("returns error for --lines with non-numeric value", () => {
    const result = parseLogsArgs(["myserver", "--lines", "abc"]);
    expect(result.error).toBe("--lines requires a number");
  });

  test("returns undefined server when no positional arg", () => {
    const result = parseLogsArgs(["-f"]);
    expect(result.server).toBeUndefined();
  });

  test("handles all options combined", () => {
    const result = parseLogsArgs(["-f", "--lines", "200", "myserver"]);
    expect(result.server).toBe("myserver");
    expect(result.follow).toBe(true);
    expect(result.lines).toBe(200);
    expect(result.error).toBeUndefined();
  });

  test("returns defaults for empty args", () => {
    const result = parseLogsArgs([]);
    expect(result.server).toBeUndefined();
    expect(result.follow).toBe(false);
    expect(result.lines).toBe(50);
    expect(result.error).toBeUndefined();
  });
});
