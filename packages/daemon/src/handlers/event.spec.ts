import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import { IPC_ERROR } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { EventHandlers } from "./event";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockEventBus() {
  return {
    publish: (input: unknown) => ({ seq: 1, ...(input as object) }),
  } as never;
}

function buildHandlers(bus = mockEventBus()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new EventHandlers(bus).register(map);
  return map;
}

describe("EventHandlers", () => {
  test("publishEvent publishes to eventBus", async () => {
    const map = buildHandlers();
    const result = (await invoke(map, "publishEvent")(
      { src: "test", event: "test.event", category: "session" },
      {} as never,
    )) as { ok: boolean; seq: number };
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(1);
  });

  test("publishEvent throws when no eventBus", async () => {
    const map = buildHandlers(null as never);
    await expect(
      invoke(map, "publishEvent")({ src: "test", event: "test.event", category: "session" }, {} as never),
    ).rejects.toMatchObject({ code: IPC_ERROR.INTERNAL_ERROR });
  });
});
