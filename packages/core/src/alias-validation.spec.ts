import { describe, expect, it } from "bun:test";
import { options, safeAliasPath, validateAliasName } from "./constants";

describe("validateAliasName", () => {
  it("accepts valid names", () => {
    expect(() => validateAliasName("my-alias")).not.toThrow();
    expect(() => validateAliasName("my_alias")).not.toThrow();
    expect(() => validateAliasName("alias123")).not.toThrow();
    expect(() => validateAliasName("A")).not.toThrow();
    expect(() => validateAliasName("a-b_c-123")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateAliasName("")).toThrow("Invalid alias name");
  });

  it("rejects path traversal", () => {
    expect(() => validateAliasName("../evil")).toThrow("Invalid alias name");
    expect(() => validateAliasName("../../.bashrc")).toThrow("Invalid alias name");
    expect(() => validateAliasName("foo/bar")).toThrow("Invalid alias name");
  });

  it("rejects absolute paths", () => {
    expect(() => validateAliasName("/etc/passwd")).toThrow("Invalid alias name");
  });

  it("rejects dots", () => {
    expect(() => validateAliasName(".hidden")).toThrow("Invalid alias name");
    expect(() => validateAliasName("..")).toThrow("Invalid alias name");
    expect(() => validateAliasName("foo.bar")).toThrow("Invalid alias name");
  });

  it("rejects special characters", () => {
    expect(() => validateAliasName("foo bar")).toThrow("Invalid alias name");
    expect(() => validateAliasName("foo;rm -rf")).toThrow("Invalid alias name");
    expect(() => validateAliasName("$(whoami)")).toThrow("Invalid alias name");
    expect(() => validateAliasName("foo\0bar")).toThrow("Invalid alias name");
  });
});

describe("safeAliasPath", () => {
  it("returns path inside options.ALIASES_DIR for valid names", () => {
    const result = safeAliasPath("my-alias");
    expect(result).toBe(`${options.ALIASES_DIR}/my-alias.ts`);
    expect(result.startsWith(`${options.ALIASES_DIR}/`)).toBe(true);
  });

  it("rejects path traversal via name validation", () => {
    expect(() => safeAliasPath("../../.bashrc")).toThrow("Invalid alias name");
    expect(() => safeAliasPath("../evil")).toThrow("Invalid alias name");
  });

  it("rejects empty name", () => {
    expect(() => safeAliasPath("")).toThrow("Invalid alias name");
  });
});
