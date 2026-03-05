import { describe, expect, test } from "bun:test";
import { DEFINE_ALIAS_SENTINEL, isDefineAlias } from "./alias";

describe("DEFINE_ALIAS_SENTINEL", () => {
  test("is the expected string", () => {
    expect(DEFINE_ALIAS_SENTINEL).toBe("defineAlias(");
  });
});

describe("isDefineAlias", () => {
  test("detects defineAlias call", () => {
    const source = 'defineAlias(({ z }) => ({ name: "test", fn: () => "ok" }));';
    expect(isDefineAlias(source)).toBe(true);
  });

  test("detects defineAlias with import statement", () => {
    const source = 'import { defineAlias } from "mcp-cli";\ndefineAlias({ name: "test" });';
    expect(isDefineAlias(source)).toBe(true);
  });

  test("returns false for freeform scripts", () => {
    const source = 'import { mcp } from "mcp-cli";\nconsole.log("hello");';
    expect(isDefineAlias(source)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isDefineAlias("")).toBe(false);
  });

  test("detects defineAlias even in comments (known false positive)", () => {
    expect(isDefineAlias("// defineAlias( is not a real call")).toBe(true);
  });

  test("returns false for partial match without open paren", () => {
    expect(isDefineAlias("const defineAlias = 42")).toBe(false);
  });
});
