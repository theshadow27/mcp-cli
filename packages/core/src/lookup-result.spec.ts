import { describe, expect, mock, test } from "bun:test";
import { isLookupFailure, lookupFailure, resolveGitRootOrCwd } from "./lookup-result";

describe("lookupFailure", () => {
  test("creates a tagged failure object", () => {
    const f = lookupFailure("git broke");
    expect(f._tag).toBe("lookup-failure");
    expect(f.message).toBe("git broke");
  });
});

describe("isLookupFailure", () => {
  test("returns true for LookupFailure objects", () => {
    expect(isLookupFailure(lookupFailure("err"))).toBe(true);
  });

  test("returns false for null", () => {
    expect(isLookupFailure(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isLookupFailure(undefined)).toBe(false);
  });

  test("returns false for strings", () => {
    expect(isLookupFailure("+10/-5 (3f)")).toBe(false);
  });

  test("returns false for plain objects without _tag", () => {
    expect(isLookupFailure({ number: 42, state: "open" })).toBe(false);
  });

  test("returns false for objects with wrong _tag", () => {
    expect(isLookupFailure({ _tag: "something-else", message: "hi" })).toBe(false);
  });
});

describe("resolveGitRootOrCwd", () => {
  test("returns git root on success", () => {
    const result = resolveGitRootOrCwd(
      () => "/repo",
      mock(() => {}),
    );
    expect(result).toBe("/repo");
  });

  test("falls back to cwd when git root is null", () => {
    const result = resolveGitRootOrCwd(
      () => null,
      mock(() => {}),
      () => "/fallback",
    );
    expect(result).toBe("/fallback");
  });

  test("logs and falls back to cwd on LookupFailure", () => {
    const printError = mock(() => {});
    const result = resolveGitRootOrCwd(
      () => lookupFailure("git not found"),
      printError,
      () => "/fallback",
    );
    expect(result).toBe("/fallback");
    expect(printError).toHaveBeenCalledWith("git not found");
  });
});
