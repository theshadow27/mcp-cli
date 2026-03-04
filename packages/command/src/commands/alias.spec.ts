import { describe, expect, test } from "bun:test";
import { DEFINE_ALIAS_SKELETON, extractDefinitionName, wrapDefineAlias } from "./alias.js";

describe("wrapDefineAlias", () => {
  test("wraps object literal into full defineAlias script", () => {
    const code = '{ name: "greet", fn: (name) => `Hello, ${name}!` }';
    const result = wrapDefineAlias(code);
    expect(result).toBe(`import { defineAlias, z } from "mcp-cli";\ndefineAlias(({ mcp, z }) => (${code}));\n`);
  });

  test("includes import and defineAlias sentinel", () => {
    const result = wrapDefineAlias("{}");
    expect(result).toContain('import { defineAlias, z } from "mcp-cli"');
    expect(result).toContain("defineAlias(");
  });
});

describe("extractDefinitionName", () => {
  test("extracts name from double-quoted field", () => {
    expect(extractDefinitionName('{ name: "greet", fn: () => {} }')).toBe("greet");
  });

  test("extracts name from single-quoted field", () => {
    expect(extractDefinitionName("{ name: 'my-tool', fn: () => {} }")).toBe("my-tool");
  });

  test("handles extra whitespace around colon", () => {
    expect(extractDefinitionName('{ name :  "spaced" }')).toBe("spaced");
  });

  test("returns undefined when no name field", () => {
    expect(extractDefinitionName("{ fn: () => {} }")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractDefinitionName("")).toBeUndefined();
  });

  test("extracts first name if multiple appear", () => {
    const code = '{ name: "first", nested: { name: "second" } }';
    expect(extractDefinitionName(code)).toBe("first");
  });
});

describe("DEFINE_ALIAS_SKELETON", () => {
  test("contains defineAlias import", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain('import { defineAlias, z } from "mcp-cli"');
  });

  test("contains defineAlias call", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain("defineAlias(");
  });

  test("contains placeholder name", () => {
    expect(DEFINE_ALIAS_SKELETON).toContain('name: "my-alias"');
  });
});
