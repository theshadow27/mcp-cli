import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { TelemetryHandlers } from "./telemetry";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    getSpans: () => [],
    markSpansExported: () => 0,
    pruneSpans: () => 0,
    ...overrides,
  } as never;
}

function buildHandlers(db = mockDb()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new TelemetryHandlers(db).register(map);
  return map;
}

describe("TelemetryHandlers", () => {
  test("getSpans delegates to db", async () => {
    const spans = [{ traceId: "abc" }];
    const map = buildHandlers(mockDb({ getSpans: () => spans }));
    const result = (await invoke(map, "getSpans")(undefined, {} as never)) as { spans: unknown[] };
    expect(result.spans).toEqual(spans);
  });

  test("markSpansExported delegates to db", async () => {
    const map = buildHandlers(mockDb({ markSpansExported: () => 3 }));
    const result = (await invoke(map, "markSpansExported")({ ids: [1, 2, 3] }, {} as never)) as {
      marked: number;
    };
    expect(result.marked).toBe(3);
  });

  test("pruneSpans delegates to db", async () => {
    const map = buildHandlers(mockDb({ pruneSpans: () => 5 }));
    const result = (await invoke(map, "pruneSpans")({ before: 1000 }, {} as never)) as { pruned: number };
    expect(result.pruned).toBe(5);
  });

  test("pruneSpans works with no params", async () => {
    const map = buildHandlers();
    const result = (await invoke(map, "pruneSpans")(undefined, {} as never)) as { pruned: number };
    expect(result.pruned).toBe(0);
  });
});
