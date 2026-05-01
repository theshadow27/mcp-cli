import { describe, expect, test } from "bun:test";
import type { IpcMethod, Logger, ServeInstanceInfo } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { ServeHandlers } from "./serve";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function noopLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;
}

const noopKill = async (_pid: number, _logger: Logger) => {};

function buildHandlers(killPidFn = noopKill): {
  map: Map<IpcMethod, RequestHandler>;
  instances: Map<string, ServeInstanceInfo>;
} {
  const instances = new Map<string, ServeInstanceInfo>();
  const map = new Map<IpcMethod, RequestHandler>();
  new ServeHandlers(instances, noopLogger(), killPidFn).register(map);
  return { map, instances };
}

const ctx = {} as never;

describe("ServeHandlers", () => {
  describe("registerServe", () => {
    test("adds instance to map", async () => {
      const { map, instances } = buildHandlers();
      const result = (await invoke(map, "registerServe")(
        { instanceId: "inst-1", pid: 1234, tools: ["tool-a"] },
        ctx,
      )) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(instances.has("inst-1")).toBe(true);
      expect(instances.get("inst-1")?.pid).toBe(1234);
    });

    test("records startedAt timestamp", async () => {
      const { map, instances } = buildHandlers();
      const before = Date.now();
      await invoke(map, "registerServe")({ instanceId: "i1", pid: 111, tools: [] }, ctx);
      const after = Date.now();
      expect(instances.get("i1")?.startedAt).toBeGreaterThanOrEqual(before);
      expect(instances.get("i1")?.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("unregisterServe", () => {
    test("removes existing instance", async () => {
      const { map, instances } = buildHandlers();
      await invoke(map, "registerServe")({ instanceId: "i1", pid: 111, tools: [] }, ctx);
      const result = (await invoke(map, "unregisterServe")({ instanceId: "i1" }, ctx)) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(instances.has("i1")).toBe(false);
    });

    test("no-ops when instance does not exist", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "unregisterServe")({ instanceId: "missing" }, ctx)) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  });

  describe("listServeInstances", () => {
    test("returns registered instances with live PIDs", async () => {
      const { map } = buildHandlers();
      await invoke(map, "registerServe")({ instanceId: "a", pid: process.pid, tools: ["x"] }, ctx);
      await invoke(map, "registerServe")({ instanceId: "b", pid: process.pid, tools: ["y"] }, ctx);
      const list = (await invoke(map, "listServeInstances")(undefined, ctx)) as ServeInstanceInfo[];
      expect(list.length).toBe(2);
      expect(list.map((i) => i.instanceId).sort()).toEqual(["a", "b"]);
    });

    test("prunes instances with dead PIDs", async () => {
      const { map } = buildHandlers();
      await invoke(map, "registerServe")({ instanceId: "alive", pid: process.pid, tools: [] }, ctx);
      await invoke(map, "registerServe")({ instanceId: "dead", pid: 2_000_000_000, tools: [] }, ctx);
      const list = (await invoke(map, "listServeInstances")(undefined, ctx)) as ServeInstanceInfo[];
      expect(list.map((i) => i.instanceId)).toContain("alive");
      expect(list.map((i) => i.instanceId)).not.toContain("dead");
    });
  });

  describe("killServe", () => {
    test("throws INVALID_PARAMS when no selector given", async () => {
      const { map } = buildHandlers();
      await expect(invoke(map, "killServe")({}, ctx)).rejects.toMatchObject({
        message: "Specify instanceId, pid, all, or staleHours",
      });
    });

    test("throws SERVER_NOT_FOUND for unknown instanceId", async () => {
      const { map } = buildHandlers();
      await expect(invoke(map, "killServe")({ instanceId: "nonexistent" }, ctx)).rejects.toMatchObject({
        message: 'Serve instance "nonexistent" not found',
      });
    });

    test("throws SERVER_NOT_FOUND when no instance matches pid", async () => {
      const { map } = buildHandlers();
      await expect(invoke(map, "killServe")({ pid: 99999999 }, ctx)).rejects.toMatchObject({
        message: "No serve instance with PID 99999999",
      });
    });

    test("kills all instances when all=true", async () => {
      const { map, instances } = buildHandlers();
      // Use process.pid so instances survive pruneStaleInstances; noopKill prevents actual SIGTERM
      instances.set("x", { instanceId: "x", pid: process.pid, tools: [], startedAt: Date.now() });
      instances.set("y", { instanceId: "y", pid: process.pid, tools: [], startedAt: Date.now() });
      const result = (await invoke(map, "killServe")({ all: true }, ctx)) as { killed: number };
      expect(result.killed).toBe(2);
      expect(instances.size).toBe(0);
    });

    test("staleHours filters by age", async () => {
      const { map, instances } = buildHandlers();
      // Use process.pid so instances survive pruneStaleInstances; noopKill prevents actual SIGTERM
      instances.set("fresh", { instanceId: "fresh", pid: process.pid, tools: [], startedAt: Date.now() });
      instances.set("stale", { instanceId: "stale", pid: process.pid, tools: [], startedAt: 0 });
      const result = (await invoke(map, "killServe")({ staleHours: 1 }, ctx)) as { killed: number };
      expect(result.killed).toBe(1);
      expect(instances.has("stale")).toBe(false);
      expect(instances.has("fresh")).toBe(true);
    });

    test("kills by instanceId and removes from map", async () => {
      const { map, instances } = buildHandlers();
      instances.set("target", { instanceId: "target", pid: process.pid, tools: [], startedAt: Date.now() });
      const result = (await invoke(map, "killServe")({ instanceId: "target" }, ctx)) as { killed: number };
      expect(result.killed).toBe(1);
      expect(instances.has("target")).toBe(false);
    });
  });
});
