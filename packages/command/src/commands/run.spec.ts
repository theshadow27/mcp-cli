import { describe, expect, test } from "bun:test";
import { parseRunArgs } from "./run";

describe("parseRunArgs", () => {
  test("parses --key value pairs", () => {
    expect(parseRunArgs(["--name", "alice", "--age", "30"])).toEqual({
      jsonInput: undefined,
      cliArgs: { name: "alice", age: "30" },
    });
  });

  test("returns empty for no args", () => {
    expect(parseRunArgs([])).toEqual({ jsonInput: undefined, cliArgs: {} });
  });

  test("ignores flags without a following value", () => {
    expect(parseRunArgs(["--orphan"])).toEqual({ jsonInput: undefined, cliArgs: {} });
  });

  test("captures first positional arg as jsonInput", () => {
    expect(parseRunArgs(['{"email":"a@b.com"}', "--key", "val"])).toEqual({
      jsonInput: '{"email":"a@b.com"}',
      cliArgs: { key: "val" },
    });
  });

  test("captures plain string as jsonInput", () => {
    expect(parseRunArgs(['"hello"'])).toEqual({
      jsonInput: '"hello"',
      cliArgs: {},
    });
  });

  test("last value wins for duplicate keys", () => {
    expect(parseRunArgs(["--k", "first", "--k", "second"])).toEqual({
      jsonInput: undefined,
      cliArgs: { k: "second" },
    });
  });

  test("handles values that look like flags", () => {
    expect(parseRunArgs(["--flag", "--other"])).toEqual({
      jsonInput: undefined,
      cliArgs: { flag: "--other" },
    });
  });

  test("json input and flags together", () => {
    expect(parseRunArgs(['{"q":"test"}', "--verbose", "true"])).toEqual({
      jsonInput: '{"q":"test"}',
      cliArgs: { verbose: "true" },
    });
  });
});
