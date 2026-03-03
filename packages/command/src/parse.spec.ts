import { describe, expect, test } from "bun:test";
import { splitServerTool } from "./parse.js";

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
