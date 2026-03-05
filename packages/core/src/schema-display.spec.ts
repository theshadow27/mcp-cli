import { describe, expect, test } from "bun:test";
import { type JsonSchema, formatAliasSignature, formatToolSignature, jsonSchemaToTs } from "./schema-display";

describe("jsonSchemaToTs", () => {
  test("primitive types", () => {
    expect(jsonSchemaToTs({ type: "string" })).toBe("string");
    expect(jsonSchemaToTs({ type: "number" })).toBe("number");
    expect(jsonSchemaToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTs({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToTs({ type: "null" })).toBe("null");
  });

  test("no type returns unknown", () => {
    expect(jsonSchemaToTs({})).toBe("unknown");
  });

  test("enum values", () => {
    expect(jsonSchemaToTs({ enum: ["a", "b", "c"] })).toBe("'a' | 'b' | 'c'");
    expect(jsonSchemaToTs({ enum: [1, 2] })).toBe("1 | 2");
    expect(jsonSchemaToTs({ enum: ["markdown", "adf"] })).toBe("'markdown' | 'adf'");
  });

  test("const value", () => {
    expect(jsonSchemaToTs({ const: "fixed" })).toBe("'fixed'");
    expect(jsonSchemaToTs({ const: 42 })).toBe("42");
    expect(jsonSchemaToTs({ const: null })).toBe("null");
  });

  test("array types", () => {
    expect(jsonSchemaToTs({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(jsonSchemaToTs({ type: "array" })).toBe("unknown[]");
  });

  test("array of union wraps in parens", () => {
    const schema: JsonSchema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
    };
    expect(jsonSchemaToTs(schema)).toBe("(string | number)[]");
  });

  test("tuple array", () => {
    const schema: JsonSchema = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    };
    expect(jsonSchemaToTs(schema)).toBe("[string, number]");
  });

  test("simple object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    expect(jsonSchemaToTs(schema)).toBe("{name: string, age?: number}");
  });

  test("object without properties", () => {
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
  });

  test("object with additionalProperties schema", () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: { type: "string" },
    };
    expect(jsonSchemaToTs(schema)).toBe("Record<string, string>");
  });

  test("nested object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      required: ["user"],
    };
    expect(jsonSchemaToTs(schema)).toBe("{user: {id: string}}");
  });

  test("anyOf union", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };
    expect(jsonSchemaToTs(schema)).toBe("string | number");
  });

  test("oneOf union", () => {
    const schema: JsonSchema = {
      oneOf: [{ type: "string" }, { type: "null" }],
    };
    expect(jsonSchemaToTs(schema)).toBe("string | null");
  });

  test("allOf intersection", () => {
    const schema: JsonSchema = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    };
    expect(jsonSchemaToTs(schema)).toBe("{a: string} & {b: number}");
  });

  test("type as array (nullable)", () => {
    const schema: JsonSchema = { type: ["string", "null"] };
    expect(jsonSchemaToTs(schema)).toBe("string | null");
  });

  test("depth limit collapses objects", () => {
    const deep: JsonSchema = {
      type: "object",
      properties: {
        l1: {
          type: "object",
          properties: {
            l2: {
              type: "object",
              properties: {
                l3: {
                  type: "object",
                  properties: { l4: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
    const result = jsonSchemaToTs(deep, { maxDepth: 2 });
    expect(result).toContain("{...}");
  });

  test("prop limit truncates", () => {
    const manyProps: Record<string, JsonSchema> = {};
    for (let i = 0; i < 15; i++) {
      manyProps[`prop${i}`] = { type: "string" };
    }
    const schema: JsonSchema = { type: "object", properties: manyProps };
    const result = jsonSchemaToTs(schema, { maxProps: 5 });
    expect(result).toContain("...10 more");
  });

  test("infers object from properties without type", () => {
    const schema: JsonSchema = {
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    expect(jsonSchemaToTs(schema)).toBe("{id: string}");
  });

  test("infers array from items without type", () => {
    const schema: JsonSchema = {
      items: { type: "number" },
    };
    expect(jsonSchemaToTs(schema)).toBe("number[]");
  });
});

describe("formatToolSignature", () => {
  test("empty params", () => {
    expect(formatToolSignature("ping", {})).toBe("ping()");
    expect(formatToolSignature("ping", { type: "object" })).toBe("ping()");
  });

  test("required and optional params", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    };
    expect(formatToolSignature("search", schema)).toBe("search({query: string, limit?: number})");
  });

  test("enum params", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        format: { enum: ["json", "xml"] },
      },
    };
    expect(formatToolSignature("export", schema)).toBe("export({format?: 'json' | 'xml'})");
  });

  test("truncates many params", () => {
    const props: Record<string, JsonSchema> = {};
    for (let i = 0; i < 12; i++) {
      props[`p${i}`] = { type: "string" };
    }
    const schema: JsonSchema = { type: "object", properties: props };
    const sig = formatToolSignature("big", schema);
    expect(sig).toContain("...4 more");
  });

  test("real-world MCP tool schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        cloudId: { type: "string", description: "Cloud ID" },
        pageId: { type: "string", description: "Page ID" },
        contentFormat: { enum: ["markdown", "adf"], description: "Format" },
      },
      required: ["cloudId", "pageId"],
    };
    expect(formatToolSignature("getConfluencePage", schema)).toBe(
      "getConfluencePage({cloudId: string, pageId: string, contentFormat?: 'markdown' | 'adf'})",
    );
  });
});

describe("formatAliasSignature", () => {
  test("no schemas", () => {
    expect(formatAliasSignature("my-alias")).toBe("my-alias()");
    expect(formatAliasSignature("my-alias", undefined, undefined)).toBe("my-alias()");
  });

  test("input schema only", () => {
    const input: JsonSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    expect(formatAliasSignature("search", input)).toBe("search({query: string})");
  });

  test("input and output schemas", () => {
    const input: JsonSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const output: JsonSchema = {
      type: "object",
      properties: {
        dashboards: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, url: { type: "string" } },
            required: ["name", "url"],
          },
        },
      },
      required: ["dashboards"],
    };
    expect(formatAliasSignature("gf-search", input, output)).toBe(
      "gf-search({query: string}): {dashboards: {name: string, url: string}[]}",
    );
  });

  test("output schema only", () => {
    const output: JsonSchema = {
      type: "object",
      properties: { panels: { type: "array", items: { type: "string" } } },
      required: ["panels"],
    };
    expect(formatAliasSignature("go-dashboards", undefined, output)).toBe("go-dashboards(): {panels: string[]}");
  });

  test("empty input schema properties", () => {
    const input: JsonSchema = { type: "object", properties: {} };
    expect(formatAliasSignature("ping", input)).toBe("ping()");
  });

  test("output with no useful type returns no colon", () => {
    const output: JsonSchema = {};
    expect(formatAliasSignature("test", undefined, output)).toBe("test()");
  });
});
