import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { BudgetHandlers } from "./budget";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockDb(overrides: Partial<{ getBudgetConfig: () => unknown; setBudgetConfig: (cfg: unknown) => void }> = {}) {
  return {
    getBudgetConfig: () => ({ weekly: 10, monthly: 40 }),
    setBudgetConfig: () => {},
    ...overrides,
  } as never;
}

function buildHandlers(db = mockDb()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new BudgetHandlers(db).register(map);
  return map;
}

describe("BudgetHandlers", () => {
  test("getBudgetConfig returns db result", async () => {
    const cfg = { weekly: 5, monthly: 20 };
    const map = buildHandlers(mockDb({ getBudgetConfig: () => cfg }));
    const result = await invoke(map, "getBudgetConfig")(undefined, {} as never);
    expect(result).toEqual(cfg);
  });

  test("setBudgetConfig calls db.setBudgetConfig", async () => {
    let saved: unknown;
    const map = buildHandlers(
      mockDb({
        setBudgetConfig: (cfg) => {
          saved = cfg;
        },
      }),
    );
    const result = await invoke(map, "setBudgetConfig")({ weekly: 3 }, {} as never);
    expect(result).toEqual({ ok: true });
    expect(saved).toBeTruthy();
  });

  test("setBudgetConfig rejects invalid params", async () => {
    const map = buildHandlers();
    await expect(invoke(map, "setBudgetConfig")("not-an-object", {} as never)).rejects.toThrow();
  });
});
