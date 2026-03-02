import { describe, expect, test } from "bun:test";
import { parseRunArgs } from "./run.js";

describe("parseRunArgs", () => {
  test("parses --key value pairs", () => {
    expect(parseRunArgs(["--name", "alice", "--age", "30"])).toEqual({
      name: "alice",
      age: "30",
    });
  });

  test("returns empty object for no args", () => {
    expect(parseRunArgs([])).toEqual({});
  });

  test("ignores flags without a following value", () => {
    expect(parseRunArgs(["--orphan"])).toEqual({});
  });

  test("ignores positional args without -- prefix", () => {
    expect(parseRunArgs(["positional", "--key", "val"])).toEqual({ key: "val" });
  });

  test("last value wins for duplicate keys", () => {
    expect(parseRunArgs(["--k", "first", "--k", "second"])).toEqual({ k: "second" });
  });

  test("handles values that look like flags", () => {
    // --flag --other-flag is parsed as flag="--other-flag"
    expect(parseRunArgs(["--flag", "--other"])).toEqual({ flag: "--other" });
  });
});
