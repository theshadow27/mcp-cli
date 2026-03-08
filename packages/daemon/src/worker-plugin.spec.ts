import { describe, expect, mock, test } from "bun:test";
import type { AliasDefinition } from "@mcp-cli/core";
import { buildMcpExports, stubProxy } from "./worker-plugin";

describe("stubProxy", () => {
  test("returns undefined for any server.tool() call", async () => {
    const result = await stubProxy.anyServer.anyTool({ key: "value" });
    expect(result).toBeUndefined();
  });

  test("returns undefined for different server/tool combinations", async () => {
    expect(await stubProxy.foo.bar()).toBeUndefined();
    expect(await stubProxy.baz.qux({ a: 1 })).toBeUndefined();
  });

  test("server proxy returns function for any tool name", () => {
    const server = stubProxy.myServer;
    expect(typeof server.tool1).toBe("function");
    expect(typeof server.tool2).toBe("function");
  });
});

describe("buildMcpExports", () => {
  test("defineAlias captures a plain definition", () => {
    const onDefine = mock();
    const exports = buildMcpExports({
      onDefine,
      file: () => Promise.resolve(""),
      json: () => Promise.resolve(null),
    });

    const def: AliasDefinition = { name: "test", description: "desc", fn: () => "ok" };
    exports.defineAlias(def);

    expect(onDefine).toHaveBeenCalledWith(def);
  });

  test("defineAlias invokes factory function with mcp and z", () => {
    const onDefine = mock();
    const exports = buildMcpExports({
      onDefine,
      file: () => Promise.resolve(""),
      json: () => Promise.resolve(null),
    });

    exports.defineAlias(({ mcp, z }) => {
      expect(mcp).toBe(stubProxy);
      expect(z).toBeDefined();
      return { name: "from-factory", description: "d", fn: () => "ok" };
    });

    expect(onDefine).toHaveBeenCalledWith(
      expect.objectContaining({ name: "from-factory" }),
    );
  });

  test("exports include z, mcp, args, file, and json", () => {
    const file = mock(() => Promise.resolve("content"));
    const json = mock(() => Promise.resolve({ key: "val" }));
    const exports = buildMcpExports({
      onDefine: () => {},
      file,
      json,
    });

    expect(exports.z).toBeDefined();
    expect(exports.mcp).toBe(stubProxy);
    expect(exports.args).toEqual({});
    expect(exports.file).toBe(file);
    expect(exports.json).toBe(json);
  });
});
