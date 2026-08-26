import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { NO_REPO_ROOT, resolveRealpath } from "@mcp-cli/core";
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
      const result = (await invoke(map, "listWorkItems")(undefined, ctx)) as {
        items: Array<{ id: string }>;
        hiddenCount: number;
      };
      expect(result.items.length).toBe(2);
      expect(result.hiddenCount).toBe(0);
    });

    test("filters by phase", async () => {
      const { map } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 1, initialPhase: "impl" }, ctx);
      await invoke(map, "trackWorkItem")({ number: 2, initialPhase: "review" }, ctx);
      const result = (await invoke(map, "listWorkItems")({ phase: "review" }, ctx)) as {
        items: Array<{ phase: string }>;
        hiddenCount: number;
      };
      expect(result.items.length).toBe(1);
      expect(result.items[0].phase).toBe("review");
    });

    test("returns empty array when no items", async () => {
      const { map } = buildHandlers();
      const result = (await invoke(map, "listWorkItems")(undefined, ctx)) as { items: unknown[]; hiddenCount: number };
      expect(result.items).toEqual([]);
      expect(result.hiddenCount).toBe(0);
    });

    test("includeArchived=false sets excludeArchived, hiddenCount reflects stale done items", async () => {
      const { map, workItemDb } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 1, initialPhase: "done" }, ctx);
      // Back-date to simulate stale
      (workItemDb as unknown as { db: import("bun:sqlite").Database }).db
        .prepare("UPDATE work_items SET updated_at = datetime('now', '-8 days') WHERE id = '#1'")
        .run();
      const result = (await invoke(map, "listWorkItems")({ includeArchived: false }, ctx)) as {
        items: unknown[];
        hiddenCount: number;
      };
      expect(result.items).toHaveLength(0);
      expect(result.hiddenCount).toBe(1);
    });

    test("includeArchived=true returns all items with hiddenCount=0", async () => {
      const { map, workItemDb } = buildHandlers();
      await invoke(map, "trackWorkItem")({ number: 1, initialPhase: "done" }, ctx);
      (workItemDb as unknown as { db: import("bun:sqlite").Database }).db
        .prepare("UPDATE work_items SET updated_at = datetime('now', '-8 days') WHERE id = '#1'")
        .run();
      const result = (await invoke(map, "listWorkItems")({ includeArchived: true }, ctx)) as {
        items: unknown[];
        hiddenCount: number;
      };
      expect(result.items).toHaveLength(1);
      expect(result.hiddenCount).toBe(0);
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

    // #3376 — the sentinel must reach the DB as the sentinel. Every handler previously did
    // `resolveRealpath(resolve(repoRoot))`, and `resolve("__none__")` is
    // `<daemon-cwd>/__none__`: a real path, dependent on where mcpd happened to be started,
    // and a different row from the literal `"__none__"` the daemon's own automation reader
    // queries. Assert against the store key, not the round trip — a round trip passes
    // either way, which is why this went unnoticed.
    test("NO_REPO_ROOT is stored verbatim, not resolved against the daemon's cwd", async () => {
      const { map, aliasDb } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot: NO_REPO_ROOT, namespace, key: "k", value: 7 }, ctx);
      expect(aliasDb.getAliasState(NO_REPO_ROOT, namespace, "k")).toBe(7);
      expect(aliasDb.getAliasState(resolve(NO_REPO_ROOT), namespace, "k")).toBeUndefined();
    });

    test("all four handlers agree on the sentinel row", async () => {
      const { map } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot: NO_REPO_ROOT, namespace, key: "a", value: 1 }, ctx);
      const got = (await invoke(map, "aliasStateGet")({ repoRoot: NO_REPO_ROOT, namespace, key: "a" }, ctx)) as {
        value: unknown;
      };
      expect(got.value).toBe(1);
      const all = (await invoke(map, "aliasStateAll")({ repoRoot: NO_REPO_ROOT, namespace }, ctx)) as {
        entries: Record<string, unknown>;
      };
      expect(all.entries).toEqual({ a: 1 });
      const del = (await invoke(map, "aliasStateDelete")({ repoRoot: NO_REPO_ROOT, namespace, key: "a" }, ctx)) as {
        deleted: boolean;
      };
      expect(del.deleted).toBe(true);
    });

    test("a real absolute root is still realpathed and trailing-slash-normalized", async () => {
      const { map, aliasDb } = buildHandlers();
      await invoke(map, "aliasStateSet")({ repoRoot: `${repoRoot}/`, namespace, key: "n", value: "v" }, ctx);
      expect(aliasDb.getAliasState(resolveRealpath(repoRoot), namespace, "n")).toBe("v");
    });
  });
});

/**
 * The IPC surface partitions the same way the MCP tools do, from the same input: the
 * caller's cwd. `mcx track` in project A and `mcx track` in project B are two projects,
 * not one queue.
 */
describe("WorkItemHandlers – domain scoping (#3037)", () => {
  const ALPHA = { id: 1, name: "alpha", host: null, path: "/home/u/alpha", createdAt: "2026-08-22T00:00:00.000Z" };
  const BETA = { id: 2, name: "beta", host: null, path: "/home/u/beta", createdAt: "2026-08-22T00:00:00.000Z" };

  function buildScopedHandlers() {
    const sqliteDb = new Database(":memory:");
    const workItemDb = new WorkItemDb(sqliteDb);
    const db = {
      ...makeAliasStateDb(),
      resolveDomain(path: string) {
        for (const d of [ALPHA, BETA]) {
          if (path === d.path || path.startsWith(`${d.path}/`)) return d;
        }
        return null;
      },
    };
    const map = new Map<IpcMethod, RequestHandler>();
    new WorkItemHandlers(workItemDb, db as never, null, null, noopLogger() as never).register(map);
    return { map, workItemDb };
  }

  test("two projects each track issue #42 without colliding", async () => {
    const { map } = buildScopedHandlers();
    const a = (await invoke(map, "trackWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never)) as {
      id: string;
      domainId: number;
    };
    const b = (await invoke(map, "trackWorkItem")({ number: 42, cwd: "/home/u/beta" }, {} as never)) as {
      id: string;
      domainId: number;
    };

    expect(a.domainId).toBe(1);
    expect(b.domainId).toBe(2);
    expect(a.id).not.toBe(b.id);
  });

  test("list and get see only the calling project", async () => {
    const { map } = buildScopedHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never);
    await invoke(map, "trackWorkItem")({ number: 77, cwd: "/home/u/beta" }, {} as never);

    const alphaList = (await invoke(map, "listWorkItems")({ cwd: "/home/u/alpha" }, {} as never)) as {
      items: Array<{ issueNumber: number }>;
    };
    expect(alphaList.items.map((i) => i.issueNumber)).toEqual([42]);

    expect(await invoke(map, "getWorkItem")({ number: 77, cwd: "/home/u/alpha" }, {} as never)).toBeNull();
    expect(await invoke(map, "getWorkItem")({ number: 77, cwd: "/home/u/beta" }, {} as never)).not.toBeNull();
  });

  // The other half of R2. `cmdUntrack`'s spec stubs `untrackWorkItem` and asserts the CLI
  // cleans up the namespace named by the response's `id`. That test is worthless if the real
  // handler never sets `id` — the double would supply a field production omits, the CLI would
  // silently skip cleanup, and both tests would still be green. So this exercises the REAL
  // handler over a REAL WorkItemDb and asserts the field exists and is the canonical id.
  test("untrackWorkItem reports the canonical id it deleted, so the caller can clean up state", async () => {
    const { map } = buildScopedHandlers();
    const tracked = (await invoke(map, "trackWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never)) as {
      id: string;
    };
    expect(tracked.id).toBe("d1:#42");

    const result = (await invoke(map, "untrackWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never)) as {
      deleted: boolean;
      id?: string;
    };
    expect(result.deleted).toBe(true);
    // Not merely present — the stored spelling, which is the only one that names the row's
    // phase-state namespace.
    expect(result.id).toBe(tracked.id);
  });

  test("a branch untrack reports its canonical id too", async () => {
    const { map } = buildScopedHandlers();
    const tracked = (await invoke(map, "trackWorkItem")({ branch: "fix/foo", cwd: "/home/u/beta" }, {} as never)) as {
      id: string;
    };
    const result = (await invoke(map, "untrackWorkItem")({ branch: "fix/foo", cwd: "/home/u/beta" }, {} as never)) as {
      deleted: boolean;
      id?: string;
    };
    expect(result.deleted).toBe(true);
    expect(result.id).toBe(tracked.id);
  });

  test("a miss reports no id — the caller must not invent a namespace to clean", async () => {
    const { map } = buildScopedHandlers();
    const result = (await invoke(map, "untrackWorkItem")({ number: 999, cwd: "/home/u/alpha" }, {} as never)) as {
      deleted: boolean;
      id?: string;
    };
    expect(result.deleted).toBe(false);
    expect(result.id).toBeUndefined();
  });

  test("untrack cannot remove another project's item", async () => {
    const { map } = buildScopedHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never);

    const wrongDomain = (await invoke(map, "untrackWorkItem")({ number: 42, cwd: "/home/u/beta" }, {} as never)) as {
      deleted: boolean;
    };
    expect(wrongDomain.deleted).toBe(false);
    expect(await invoke(map, "getWorkItem")({ number: 42, cwd: "/home/u/alpha" }, {} as never)).not.toBeNull();
  });

  test("no cwd is the unassigned partition — identical to the pre-domain behaviour", async () => {
    const { map } = buildScopedHandlers();
    const item = (await invoke(map, "trackWorkItem")({ number: 42 }, {} as never)) as {
      id: string;
      domainId: number;
    };
    expect(item.domainId).toBe(0);
    expect(item.id).toBe("#42");
  });
});
