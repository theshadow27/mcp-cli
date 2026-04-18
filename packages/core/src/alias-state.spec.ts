import { describe, expect, test } from "bun:test";
import { GLOBAL_STATE_NAMESPACE, NO_REPO_ROOT, createAliasState, createEphemeralState } from "./alias-state";
import type { IpcMethod, IpcMethodResult } from "./ipc";

type Call = { method: string; params: unknown };

function makeFakeCall(store: Map<string, unknown>, calls: Call[] = []) {
  return async function fakeCall<M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> {
    calls.push({ method, params });
    const p = (params ?? {}) as { repoRoot: string; namespace: string; key?: string; value?: unknown };
    const scope = `${p.repoRoot}\u0000${p.namespace}`;
    switch (method) {
      case "aliasStateGet": {
        const storeKey = `${scope}\u0000${p.key}`;
        return { value: store.has(storeKey) ? store.get(storeKey) : undefined } as IpcMethodResult[M];
      }
      case "aliasStateSet": {
        const storeKey = `${scope}\u0000${p.key}`;
        store.set(storeKey, p.value);
        return { ok: true } as IpcMethodResult[M];
      }
      case "aliasStateDelete": {
        const storeKey = `${scope}\u0000${p.key}`;
        const deleted = store.delete(storeKey);
        return { ok: true, deleted } as IpcMethodResult[M];
      }
      case "aliasStateAll": {
        const entries: Record<string, unknown> = {};
        for (const [k, v] of store.entries()) {
          if (k.startsWith(`${scope}\u0000`)) {
            entries[k.slice(scope.length + 1)] = v;
          }
        }
        return { entries } as IpcMethodResult[M];
      }
    }
    throw new Error(`unexpected method ${method}`);
  };
}

describe("createAliasState", () => {
  test("set then get round-trips values", async () => {
    const store = new Map<string, unknown>();
    const s = createAliasState({ repoRoot: "/r", namespace: "impl", call: makeFakeCall(store) });
    await s.set("k", { x: 1 });
    expect(await s.get<{ x: number }>("k")).toEqual({ x: 1 });
  });

  test("get returns undefined for missing key", async () => {
    const store = new Map<string, unknown>();
    const s = createAliasState({ repoRoot: "/r", namespace: "impl", call: makeFakeCall(store) });
    expect(await s.get("missing")).toBeUndefined();
  });

  test("namespaces are isolated", async () => {
    const store = new Map<string, unknown>();
    const call = makeFakeCall(store);
    const impl = createAliasState({ repoRoot: "/r", namespace: "impl", call });
    const review = createAliasState({ repoRoot: "/r", namespace: "review", call });

    await impl.set("k", "impl-value");
    await review.set("k", "review-value");

    expect(await impl.get<string>("k")).toBe("impl-value");
    expect(await review.get<string>("k")).toBe("review-value");
  });

  test("delete removes a key", async () => {
    const store = new Map<string, unknown>();
    const s = createAliasState({ repoRoot: "/r", namespace: "impl", call: makeFakeCall(store) });
    await s.set("k", 1);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });

  test("all returns every key in the namespace", async () => {
    const store = new Map<string, unknown>();
    const call = makeFakeCall(store);
    const s = createAliasState({ repoRoot: "/r", namespace: "ns", call });
    const other = createAliasState({ repoRoot: "/r", namespace: "other", call });
    await s.set("a", 1);
    await s.set("b", 2);
    await other.set("c", 3);

    expect(await s.all()).toEqual({ a: 1, b: 2 });
  });

  test("sends params the daemon expects", async () => {
    const store = new Map<string, unknown>();
    const calls: Call[] = [];
    const s = createAliasState({ repoRoot: "/r", namespace: "ns", call: makeFakeCall(store, calls) });
    await s.set("k", 5);
    expect(calls[0]).toEqual({
      method: "aliasStateSet",
      params: { repoRoot: "/r", namespace: "ns", key: "k", value: 5 },
    });
  });

  test("exports stable sentinels", () => {
    expect(GLOBAL_STATE_NAMESPACE).toBe("__global__");
    expect(NO_REPO_ROOT).toBe("__none__");
  });
});

describe("createEphemeralState", () => {
  test("set then get round-trips in memory", async () => {
    const s = createEphemeralState();
    await s.set("k", { x: 1 });
    expect(await s.get<{ x: number }>("k")).toEqual({ x: 1 });
  });

  test("get returns undefined for missing key", async () => {
    const s = createEphemeralState();
    expect(await s.get("missing")).toBeUndefined();
  });

  test("separate instances are isolated", async () => {
    const a = createEphemeralState();
    const b = createEphemeralState();
    await a.set("k", "a-value");
    await b.set("k", "b-value");
    expect(await a.get<string>("k")).toBe("a-value");
    expect(await b.get<string>("k")).toBe("b-value");
  });

  test("delete removes a key", async () => {
    const s = createEphemeralState();
    await s.set("k", 1);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });

  test("all returns every key", async () => {
    const s = createEphemeralState();
    await s.set("a", 1);
    await s.set("b", 2);
    expect(await s.all()).toEqual({ a: 1, b: 2 });
  });
});
