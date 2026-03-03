import { describe, expect, test } from "bun:test";
import { extractFullFlag, extractJqFlag, splitServerTool } from "./parse.js";

describe("splitServerTool", () => {
  test("splits server/tool into tuple", () => {
    expect(splitServerTool("atlassian/search")).toEqual(["atlassian", "search"]);
  });

  test("splits on first slash only", () => {
    expect(splitServerTool("server/tool/extra")).toEqual(["server", "tool/extra"]);
  });

  test("returns null for plain word (no slash)", () => {
    expect(splitServerTool("atlassian")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(splitServerTool("")).toBeNull();
  });

  test("returns null when slash is at start", () => {
    expect(splitServerTool("/tool")).toBeNull();
  });

  test("returns null when slash is at end", () => {
    expect(splitServerTool("server/")).toBeNull();
  });

  test("handles hyphenated names", () => {
    expect(splitServerTool("my-server/my-tool")).toEqual(["my-server", "my-tool"]);
  });
});

describe("extractFullFlag", () => {
  test("extracts --full flag", () => {
    expect(extractFullFlag(["server", "tool", "--full"])).toEqual({
      full: true,
      rest: ["server", "tool"],
    });
  });

  test("extracts -f flag", () => {
    expect(extractFullFlag(["-f", "server", "tool"])).toEqual({
      full: true,
      rest: ["server", "tool"],
    });
  });

  test("returns full=false when no flag present", () => {
    expect(extractFullFlag(["server", "tool"])).toEqual({
      full: false,
      rest: ["server", "tool"],
    });
  });

  test("returns full=false for empty args", () => {
    expect(extractFullFlag([])).toEqual({ full: false, rest: [] });
  });
});

describe("extractJqFlag", () => {
  test("extracts --jq with filter", () => {
    expect(extractJqFlag(["server", "tool", "--jq", ".[:5]"])).toEqual({
      jq: ".[:5]",
      rest: ["server", "tool"],
    });
  });

  test("extracts --jq at start of args", () => {
    expect(extractJqFlag(["--jq", ".name", "server", "tool"])).toEqual({
      jq: ".name",
      rest: ["server", "tool"],
    });
  });

  test("returns undefined when no --jq flag", () => {
    expect(extractJqFlag(["server", "tool"])).toEqual({
      jq: undefined,
      rest: ["server", "tool"],
    });
  });

  test("returns undefined for empty args", () => {
    expect(extractJqFlag([])).toEqual({ jq: undefined, rest: [] });
  });

  test("handles --jq at end without value (no value to consume)", () => {
    // --jq at the very end with no following arg → treated as regular arg
    expect(extractJqFlag(["server", "--jq"])).toEqual({
      jq: undefined,
      rest: ["server", "--jq"],
    });
  });

  test("handles complex jq filter with pipes", () => {
    expect(extractJqFlag(["server", "tool", "--jq", ".[] | {id, name}"])).toEqual({
      jq: ".[] | {id, name}",
      rest: ["server", "tool"],
    });
  });
});
