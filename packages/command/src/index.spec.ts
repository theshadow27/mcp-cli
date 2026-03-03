import { describe, expect, test } from "bun:test";
import { extractJsonFlag } from "./parse.js";

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
});
