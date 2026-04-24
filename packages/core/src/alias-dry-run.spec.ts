import { describe, expect, test } from "bun:test";
import type { AliasContext } from "./alias";
import { createDryRunMcp, createDryRunState, wrapDryRunContext } from "./alias-dry-run";

describe("createDryRunMcp", () => {
  test("server proxy is not thenable — Promise.resolve does not hang", async () => {
    const lines: string[] = [];
    const mcp = createDryRunMcp((l) => lines.push(l));
    // If the server-level proxy were a thenable, Promise.resolve would call
    // .then(resolve, reject), resolve would never fire, and this would hang.
    const server = await Promise.resolve(mcp.server);
    // It resolved (didn't hang) and emitted no bogus [dry-run] lines
    expect(typeof server).toBe("object");
    expect(lines).toEqual([]);
  });

  test("symbol probes on server and tool proxies return undefined without logging", () => {
    const lines: string[] = [];
    const mcp = createDryRunMcp((l) => lines.push(l));
    // Bun inspect / V8 probe these — must not emit log lines or crash
    expect((mcp as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((mcp as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    expect((mcp.server as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((mcp.server as unknown as { then: unknown }).then).toBeUndefined();
    expect(lines).toEqual([]);
  });

  test("logs tool calls and returns undefined", async () => {
    const lines: string[] = [];
    const mcp = createDryRunMcp((l) => lines.push(l));
    const result = await mcp._work_items.work_items_update({ id: "#1241", phase: "qa" });
    expect(result).toBeUndefined();
    expect(lines).toEqual([`[dry-run] mcp._work_items.work_items_update({"id":"#1241","phase":"qa"})`]);
  });

  test("no-arg calls render with empty parens", async () => {
    const lines: string[] = [];
    const mcp = createDryRunMcp((l) => lines.push(l));
    await mcp.foo.bar();
    expect(lines).toEqual(["[dry-run] mcp.foo.bar()"]);
  });
});

describe("createDryRunState", () => {
  test("set/delete log, get/all return empty", async () => {
    const lines: string[] = [];
    const state = createDryRunState((l) => lines.push(l), "ctx.state");
    await state.set("prNumber", 123);
    await state.delete("prNumber");
    expect(await state.get("prNumber")).toBeUndefined();
    expect(await state.all()).toEqual({});
    expect(lines).toEqual([`[dry-run] ctx.state.set("prNumber", 123)`, `[dry-run] ctx.state.delete("prNumber")`]);
  });
});

describe("wrapDryRunContext", () => {
  test("intercepts mcp + state.set, passes args/file through", async () => {
    const lines: string[] = [];
    const base: AliasContext = {
      mcp: {},
      args: { foo: "bar" },
      file: async () => "file-content",
      json: async () => ({}),
      cache: async (_k, p) => p() as Promise<never>,
      state: { get: async () => undefined, all: async () => ({}), set: async () => {}, delete: async () => {} },
      globalState: { get: async () => undefined, all: async () => ({}), set: async () => {}, delete: async () => {} },
      workItem: null,
      signal: new AbortController().signal,
      waitForEvent: async () => {
        throw new Error("not in test");
      },
    };
    const ctx = wrapDryRunContext(base, (l) => lines.push(l));

    await ctx.mcp.server.tool({ x: 1 });
    await ctx.state.set("k", "v");
    await ctx.globalState.set("g", 1);
    expect(ctx.args.foo).toBe("bar");
    expect(await ctx.file("anything")).toBe("file-content");

    expect(lines).toEqual([
      `[dry-run] mcp.server.tool({"x":1})`,
      `[dry-run] ctx.state.set("k", "v")`,
      `[dry-run] ctx.globalState.set("g", 1)`,
    ]);
  });

  test("handler with 3 side effects yields exactly 3 log lines", async () => {
    const lines: string[] = [];
    const base: AliasContext = {
      mcp: {},
      args: {},
      file: async () => "",
      json: async () => ({}),
      cache: async (_k, p) => p() as Promise<never>,
      state: { get: async () => undefined, all: async () => ({}), set: async () => {}, delete: async () => {} },
      globalState: { get: async () => undefined, all: async () => ({}), set: async () => {}, delete: async () => {} },
      workItem: null,
      signal: new AbortController().signal,
      waitForEvent: async () => {
        throw new Error("not in test");
      },
    };
    const ctx = wrapDryRunContext(base, (l) => lines.push(l));

    const handler = async (c: AliasContext) => {
      await c.mcp._work_items.work_items_update({ id: "#1241", phase: "qa" });
      await c.mcp._work_items.untrack({ issue: 1241 });
      await c.state.set("prNumber", 123);
    };
    await handler(ctx);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`[dry-run] mcp._work_items.work_items_update({"id":"#1241","phase":"qa"})`);
    expect(lines[1]).toBe(`[dry-run] mcp._work_items.untrack({"issue":1241})`);
    expect(lines[2]).toBe(`[dry-run] ctx.state.set("prNumber", 123)`);
  });
});
