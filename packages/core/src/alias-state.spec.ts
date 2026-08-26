import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_STATE_NAMESPACE, createAliasState, createEphemeralState, workItemStateRoot } from "./alias-state";
import { resolveRealpath } from "./fs";
import { clearFindGitRootCache } from "./git";
import type { IpcMethod, IpcMethodResult } from "./ipc";
import { NO_REPO_ROOT, isValidStateRoot, normalizeStateRoot } from "./state-root";

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

/**
 * Real git repos, not stubs. The defect #3209 fixes is two production call sites
 * *disagreeing* about a derivation, so a test that feeds both sides a hand-built fake root
 * proves nothing — that is exactly the shape #3175 shipped and #3204 flagged.
 */
describe("workItemStateRoot", () => {
  function cleanGitEnv(): Record<string, string | undefined> {
    const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_COMMON_DIR: _c, GIT_INDEX_FILE: _i, ...rest } = process.env;
    return rest;
  }

  async function withRepo(run: (repo: string) => void | Promise<void>): Promise<void> {
    const repo = mkdtempSync(join(tmpdir(), "state-root-"));
    clearFindGitRootCache();
    try {
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      await run(repo);
    } finally {
      clearFindGitRootCache();
      rmSync(repo, { recursive: true, force: true });
    }
  }

  test("a subdirectory derives the same root as the repo root itself", async () => {
    await withRepo((repo) => {
      const sub = join(repo, "packages", "core", "src");
      mkdirSync(sub, { recursive: true });
      // The whole point: a writer standing in `sub` and a reader standing at `repo`
      // must produce one key. Before #3209 `mcx track` used `sub` verbatim.
      expect(workItemStateRoot(sub)).toBe(workItemStateRoot(repo));
      expect(workItemStateRoot(sub)).toBe(resolveRealpath(repo));
    });
  });

  test("a linked worktree derives the main checkout's root", async () => {
    await withRepo((repo) => {
      const env = {
        ...cleanGitEnv(),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      const opts = { env, stdout: "ignore" as const, stderr: "ignore" as const };
      Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "init", "-q"], opts);
      const wt = join(repo, "wt");
      const added = Bun.spawnSync(["git", "-C", repo, "worktree", "add", wt, "-b", "wt-branch", "-q"], opts);
      expect(added.exitCode).toBe(0);
      clearFindGitRootCache();
      // This is the case that actually bit: every mis-keyed row found in the wild was
      // written by `mcx track` from inside `.claude/worktrees/*`.
      expect(workItemStateRoot(wt)).toBe(resolveRealpath(repo));
    });
  });

  test("outside any git repository it is NO_REPO_ROOT, never the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-no-root-"));
    clearFindGitRootCache();
    try {
      expect(workItemStateRoot(dir)).toBe(NO_REPO_ROOT);
    } finally {
      clearFindGitRootCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown cwd is NO_REPO_ROOT, never process.cwd()", () => {
    // A daemon-side caller with no caller cwd must not silently key to the daemon's
    // own directory (PR #1307 review). `undefined` means "unknown", not "here".
    expect(workItemStateRoot(undefined)).toBe(NO_REPO_ROOT);
    expect(workItemStateRoot("")).toBe(NO_REPO_ROOT);
  });

  test("state written from a subdirectory is readable from the repo root", async () => {
    await withRepo(async (repo) => {
      const sub = join(repo, "nested");
      mkdirSync(sub, { recursive: true });
      const store = new Map<string, unknown>();
      const call = makeFakeCall(store);

      const writer = createAliasState({ repoRoot: workItemStateRoot(sub), namespace: "workitem:#42", call });
      const reader = createAliasState({ repoRoot: workItemStateRoot(repo), namespace: "workitem:#42", call });

      await writer.set("scrutiny", "high");
      expect(await reader.get<string>("scrutiny")).toBe("high");
    });
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

describe("normalizeStateRoot / isValidStateRoot — the sentinel survives the wire (#3376)", () => {
  test("NO_REPO_ROOT normalizes to itself, NOT to a daemon-cwd-relative path", () => {
    // The regression this locks: `resolveRealpath(resolve("__none__"))` is
    // `<daemon-cwd>/__none__` — a real, writable path that may even fall inside a
    // registered domain. The daemon's automation reader passes the literal sentinel to
    // db.listAliasState, so the two doors addressed different rows.
    expect(normalizeStateRoot(NO_REPO_ROOT)).toBe(NO_REPO_ROOT);
    expect(normalizeStateRoot(NO_REPO_ROOT)).not.toContain("/");
  });

  test("an absolute path is realpathed and trailing-slash-normalized", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-root-norm-"));
    try {
      expect(normalizeStateRoot(`${dir}/`)).toBe(resolveRealpath(dir));
      expect(normalizeStateRoot(dir)).toBe(normalizeStateRoot(`${dir}/`));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("workItemStateRoot and normalizeStateRoot agree — derived root == wire root", () => {
    // A client that derives its own root and a client that sends one must land on the
    // same row. That is the whole invariant; assert it directly rather than by
    // inspection of two call sites.
    const dir = mkdtempSync(join(tmpdir(), "state-root-agree-"));
    try {
      const derived = workItemStateRoot(dir, () => dir);
      expect(normalizeStateRoot(derived)).toBe(derived);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("workItemStateRoot's sentinel is a legal state root, and relative paths are not", () => {
    expect(isValidStateRoot(workItemStateRoot(undefined))).toBe(true);
    expect(isValidStateRoot(workItemStateRoot("/anywhere", () => null))).toBe(true);
    expect(isValidStateRoot("/abs/path")).toBe(true);
    // Rejected because resolve() would silently key them to the daemon's cwd.
    expect(isValidStateRoot("relative/path")).toBe(false);
    expect(isValidStateRoot("__none__x")).toBe(false);
    expect(isValidStateRoot("")).toBe(false);
  });
});
