import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import type { RequestHandler } from "../handler-types";
import { WorkItemHandlers } from "./work-item";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function noopLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/** Minimal in-memory mock of the StateDb alias state methods. */
function makeAliasStateDb() {
  const store = new Map<string, unknown>();
  const key = (root: string, ns: string, k: string) => `${root}\0${ns}\0${k}`;
  return {
    getAliasState(root: string, ns: string, k: string): unknown {
      return store.get(key(root, ns, k));
    },
    setAliasState(root: string, ns: string, k: string, v: unknown): void {
      store.set(key(root, ns, k), v);
    },
    deleteAliasState(root: string, ns: string, k: string): boolean {
      const existed = store.has(key(root, ns, k));
      store.delete(key(root, ns, k));
      return existed;
    },
    listAliasState(root: string, ns: string): Record<string, unknown> {
      const prefix = `${root}\0${ns}\0`;
      const out: Record<string, unknown> = {};
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) {
          out[k.slice(prefix.length)] = v;
        }
      }
      return out;
    },
  };
}

function buildHandlers() {
  const sqliteDb = new Database(":memory:");
  const workItemDb = new WorkItemDb(sqliteDb);
  const aliasDb = makeAliasStateDb();
  const map = new Map<IpcMethod, RequestHandler>();
  new WorkItemHandlers(workItemDb, aliasDb as never, null, null, noopLogger() as never).register(map);
  return { map, workItemDb, aliasDb };
}

const ctx = {} as never;

describe("WorkItemHandlers", () => {
  describe("trackWorkItem", () => {
    test("creates work item by issue number", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "trackWorkItem")({ number: 42 }, ctx)) as { id: string; issueNumber: number };
      expect(result.id).toBe("#42");
      expect(result.issueNumber).toBe(42);
    });

    test("creates work item by branch", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "trackWorkItem")({ branch: "feat/my-feature" }, ctx)) as {
        id: string;
        branch: string;
      };
      expect(result.id).toBe("branch:feat/my-feature");
      expect(result.branch).toBe("feat/my-feature");
    });

    test("returns existing item when issue already tracked", async () => {
      const { map } = buildHandlers();
      const r1 = (await invoke(map, "trackWorkItem")({ number: 10 }, ctx)) as { id: string };
      const r2 = (await invoke(map, "trackWorkItem")({ number: 10 }, ctx)) as { id: string };
      expect(r1.id).toBe(r2.id);
    });

    test("returns existing item when branch already tracked", async () => {
      const { map } = buildHandlers();
      const r1 = (await invoke(map, "trackWorkItem")({ branch: "fix/bug" }, ctx)) as { id: string };
      const r2 = (await invoke(map, "trackWorkItem")({ branch: "fix/bug" }, ctx)) as { id: string };
      expect(r1.id).toBe(r2.id);
    });

    test("respects initialPhase when provided", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "trackWorkItem")({ number: 5, initialPhase: "review" }, ctx)) as {
        phase: string;
      };
      expect(result.phase).toBe("review");
    });

    test("validates initialPhase against manifest when loadManifestFn provided", async () => {
      const sqliteDb = new Database(":memory:");
      const workItemDb = new WorkItemDb(sqliteDb);
      const map = new Map<IpcMethod, RequestHandler>();
      new WorkItemHandlers(
        workItemDb,
        makeAliasStateDb() as never,
        null,
        (_root: string) => ({ phases: { impl: {}, review: {} } }) as never,
        noopLogger() as never,
      ).register(map);
      await expect(
        invoke(map, "trackWorkItem")({ number: 1, initialPhase: "unknown-phase", repoRoot: "/repo" }, ctx),
      ).rejects.toThrow(/unknown initialPhase/);
    });
  });

  describe("untrackWorkItem", () => {
    test("deletes by issue number", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 7 }, ctx);
      const result = (await invoke(map, "untrackWorkItem")({ number: 7 }, ctx)) as { ok: boolean; deleted: boolean };
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(true);
    });

    test("returns deleted=false when not found by number", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "untrackWorkItem")({ number: 99 }, ctx)) as { ok: boolean; deleted: boolean };
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(false);
    });

    test("deletes by branch", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ branch: "my-branch" }, ctx);
      const result = (await invoke(map, "untrackWorkItem")({ branch: "my-branch" }, ctx)) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(true);
    });

    test("returns deleted=false when branch not found", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "untrackWorkItem")({ branch: "no-such-branch" }, ctx)) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(false);
    });
  });

  describe("listWorkItems", () => {
    test("returns all tracked items", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 1 }, ctx);
      await invoke(map, "trackWorkItem")({ number: 2 }, ctx);
      const result = (await invoke(map, "listWorkItems")(undefined, ctx)) as Array<{ id: string }>;
      expect(result.length).toBe(2);
    });

    test("filters by phase", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 1, initialPhase: "impl" }, ctx);
      await invoke(map, "trackWorkItem")({ number: 2, initialPhase: "review" }, ctx);
      const result = (await invoke(map, "listWorkItems")({ phase: "review" }, ctx)) as Array<{ phase: string }>;
      expect(result.length).toBe(1);
      expect(result[0].phase).toBe("review");
    });

    test("returns empty array when no items", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "listWorkItems")(undefined, ctx)) as unknown[];
      expect(result).toEqual([]);
    });
  });

  describe("getWorkItem", () => {
    test("returns item by id", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 3 }, ctx);
      const result = (await invoke(map, "getWorkItem")({ id: "#3" }, ctx)) as { id: string } | null;
      expect(result?.id).toBe("#3");
    });

    test("returns item by issue number", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 4 }, ctx);
      const result = (await invoke(map, "getWorkItem")({ number: 4 }, ctx)) as { issueNumber: number } | null;
      expect(result?.issueNumber).toBe(4);
    });

    test("returns item by branch", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ branch: "some-branch" }, ctx);
      const result = (await invoke(map, "getWorkItem")({ branch: "some-branch" }, ctx)) as { branch: string } | null;
      expect(result?.branch).toBe("some-branch");
    });

    test("returns null when not found", async () => {
      const { map } = buildHandlers();
      const result = await invoke(map, "getWorkItem")({ id: "#999" }, ctx);
      expect(result).toBeNull();
    });
  });

  describe("aliasStateGet / aliasStateSet / aliasStateDelete / aliasStateAll", () => {
    const repoRoot = "/tmp/test-repo";
    const namespace = "my-alias";

    test("set then get returns value", async () => {
      const { map } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot, namespace, key: "k1", value: { x: 1 } }, ctx);
      const result = (await invoke(map, "aliasStateGet")({ repoRoot, namespace, key: "k1" }, ctx)) as {
        value: unknown;
      };
      expect(result.value).toEqual({ x: 1 });
    });

    test("get returns undefined for missing key", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "aliasStateGet")({ repoRoot, namespace, key: "missing" }, ctx)) as {
        value: unknown;
      };
      expect(result.value).toBeUndefined();
    });

    test("delete removes key and returns deleted=true", async () => {
      const { map } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot, namespace, key: "toDelete", value: 42 }, ctx);
      const del = (await invoke(map, "aliasStateDelete")({ repoRoot, namespace, key: "toDelete" }, ctx)) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(del.ok).toBe(true);
      expect(del.deleted).toBe(true);
      const get = (await invoke(map, "aliasStateGet")({ repoRoot, namespace, key: "toDelete" }, ctx)) as {
        value: unknown;
      };
      expect(get.value).toBeUndefined();
    });

    test("delete returns deleted=false when key not present", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "aliasStateDelete")({ repoRoot, namespace, key: "nope" }, ctx)) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(false);
    });

    test("aliasStateAll returns all entries for namespace", async () => {
      const { map } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot, namespace, key: "a", value: 1 }, ctx);
      await invoke(map, "aliasStateSet")({ repoRoot, namespace, key: "b", value: 2 }, ctx);
      await invoke(map, "aliasStateSet")({ repoRoot, namespace: "other", key: "a", value: 99 }, ctx);
      const result = (await invoke(map, "aliasStateAll")({ repoRoot, namespace }, ctx)) as {
        entries: Record<string, unknown>;
      };
      expect(result.entries).toEqual({ a: 1, b: 2 });
    });

    test("aliasStateAll returns empty object when no entries", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "aliasStateAll")({ repoRoot, namespace: "empty" }, ctx)) as {
        entries: Record<string, unknown>;
      };
      expect(result.entries).toEqual({});
    });
  });
});
