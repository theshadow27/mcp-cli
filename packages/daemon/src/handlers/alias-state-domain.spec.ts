/**
 * `ctx.state` is domain-scoped end to end (#3040).
 *
 * Deliberately against a **real** `McxDb` and the **real** IPC handlers rather than the
 * in-memory alias-state mock used elsewhere in this directory. The property under test is
 * that two projects sharing a `(namespace, key)` do not overwrite each other, and that
 * property lives in the table's PRIMARY KEY — a mock that stores things in a Map would
 * report green no matter what the schema said. #3034's review found exactly that failure
 * mode once already.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IpcMethod, NO_DOMAIN_ID } from "@mcp-cli/core";
import { McxDb } from "../db/state";
import { WorkItemDb } from "../db/work-items";
import { createDomainResolver, createMcxDbDomainSource } from "../domain-resolver";
import type { RequestHandler } from "../handler-types";
import { WorkItemsServer } from "../work-items-server";
import { WorkItemHandlers } from "./work-item";

const ctx = {} as never;

const tempDirs: string[] = [];
const openDbs: McxDb[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mcx-domain-state-"));
  tempDirs.push(d);
  return d;
}

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A daemon with two registered domains plus one repo registered to neither, wired to the
 * real handlers through the real resolver.
 */
function setup() {
  const home = tempRoot();
  const dbPath = join(home, "mcx.db");
  const db = new McxDb(dbPath);
  openDbs.push(db);

  const phoenixPath = join(home, "phoenix");
  const clrgPath = join(home, "clrg");
  const orphanPath = join(home, "orphan");
  for (const p of [phoenixPath, clrgPath, orphanPath]) mkdirSync(p, { recursive: true });

  const phoenix = db.createDomain("phoenix", phoenixPath);
  const clrg = db.createDomain("clrg", clrgPath);

  const map = new Map<IpcMethod, RequestHandler>();
  new WorkItemHandlers(
    new WorkItemDb(db.getDatabase()),
    db,
    null,
    null,
    noopLogger as never,
    createDomainResolver(createMcxDbDomainSource(db)),
  ).register(map);

  return { db, map, phoenixPath, clrgPath, orphanPath, phoenix, clrg };
}

describe("alias_state is partitioned by domain", () => {
  test("two domains hold the same (namespace, key) without collision", async () => {
    const { map, phoenixPath, clrgPath } = setup();
    const ns = "workitem:#42";

    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: ns, key: "round", value: 1 }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: clrgPath, namespace: ns, key: "round", value: 99 }, ctx);

    const fromPhoenix = (await invoke(map, "aliasStateGet")(
      { repoRoot: phoenixPath, namespace: ns, key: "round" },
      ctx,
    )) as { value: unknown };
    const fromClrg = (await invoke(map, "aliasStateGet")({ repoRoot: clrgPath, namespace: ns, key: "round" }, ctx)) as {
      value: unknown;
    };

    expect(fromPhoenix.value).toBe(1);
    expect(fromClrg.value).toBe(99);
  });

  test("the rows land on the real domain ids, not the sentinel", async () => {
    const { db, map, phoenixPath, clrgPath, phoenix, clrg } = setup();
    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: "ns", key: "k", value: "p" }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: clrgPath, namespace: "ns", key: "k", value: "c" }, ctx);

    const rows = db
      .getDatabase()
      .query<{ domain_id: number; value_json: string }, []>(
        "SELECT domain_id, value_json FROM alias_state ORDER BY domain_id",
      )
      .all();
    expect(rows).toEqual([
      { domain_id: phoenix.id, value_json: '"p"' },
      { domain_id: clrg.id, value_json: '"c"' },
    ]);
    expect(phoenix.id).toBeGreaterThan(NO_DOMAIN_ID);
  });

  test("a repo registered to no domain keeps the sentinel partition to itself", async () => {
    const { db, map, phoenixPath, orphanPath } = setup();
    await invoke(map, "aliasStateSet")({ repoRoot: orphanPath, namespace: "ns", key: "k", value: "o" }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: "ns", key: "k", value: "p" }, ctx);

    const orphan = (await invoke(map, "aliasStateGet")({ repoRoot: orphanPath, namespace: "ns", key: "k" }, ctx)) as {
      value: unknown;
    };
    expect(orphan.value).toBe("o");
    expect(
      db
        .getDatabase()
        .query<{ n: number }, [number]>("SELECT count(*) AS n FROM alias_state WHERE domain_id = ?")
        .get(NO_DOMAIN_ID)?.n,
    ).toBe(1);
  });

  test("all() lists only the calling domain's keys", async () => {
    const { map, phoenixPath, clrgPath } = setup();
    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: "ns", key: "a", value: 1 }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: "ns", key: "b", value: 2 }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: clrgPath, namespace: "ns", key: "c", value: 3 }, ctx);

    const all = (await invoke(map, "aliasStateAll")({ repoRoot: phoenixPath, namespace: "ns" }, ctx)) as {
      entries: Record<string, unknown>;
    };
    expect(all.entries).toEqual({ a: 1, b: 2 });
  });

  test("delete in one domain leaves the other domain's key alone", async () => {
    const { map, phoenixPath, clrgPath } = setup();
    await invoke(map, "aliasStateSet")({ repoRoot: phoenixPath, namespace: "ns", key: "k", value: "p" }, ctx);
    await invoke(map, "aliasStateSet")({ repoRoot: clrgPath, namespace: "ns", key: "k", value: "c" }, ctx);

    const del = (await invoke(map, "aliasStateDelete")({ repoRoot: phoenixPath, namespace: "ns", key: "k" }, ctx)) as {
      deleted: boolean;
    };
    expect(del.deleted).toBe(true);

    const survived = (await invoke(map, "aliasStateGet")({ repoRoot: clrgPath, namespace: "ns", key: "k" }, ctx)) as {
      value: unknown;
    };
    expect(survived.value).toBe("c");
  });

  test("a path nested inside a domain resolves to that domain, not the sentinel", async () => {
    const { db, map, phoenixPath, phoenix } = setup();
    const nested = join(phoenixPath, "packages", "core");
    mkdirSync(nested, { recursive: true });

    await invoke(map, "aliasStateSet")({ repoRoot: nested, namespace: "ns", key: "k", value: 1 }, ctx);
    expect(
      db.getDatabase().query<{ domain_id: number }, []>("SELECT domain_id FROM alias_state").get()?.domain_id,
    ).toBe(phoenix.id);
  });
});

// ── R1: _work_items phase_state_* and ctx.state must be the SAME rows ──

describe("phase_state_* and ctx.state share one partition (#3040 review R1)", () => {
  /**
   * The bug this locks down: `PhaseStateStore` declared three-parameter signatures while
   * `McxDb` had a defaulted fourth, so McxDb still satisfied the interface and
   * `_work_items` wrote domain 0 while the `ctx.state` IPC handlers resolved a real
   * domain. Same repo_root, same `workitem:<id>` namespace, different rows — a
   * split-brain the compiler was silent about.
   *
   * This drives BOTH real surfaces against one database and asserts they agree. It fails
   * against the pre-fix code, where the read returns undefined.
   */
  test("a value written via _work_items is visible to ctx.state, and vice versa", async () => {
    const { db, map, phoenixPath, phoenix } = setup();
    const server = new WorkItemsServer(new WorkItemDb(db.getDatabase()), {
      phaseState: {
        store: db,
        domainIdFor: (repoRoot) => createDomainResolver(createMcxDbDomainSource(db)).idForPath(repoRoot),
      },
    });
    const { client } = await server.start();
    try {
      await client.callTool({ name: "work_items_track", arguments: { issueNumber: 42 } });

      // Write through the _work_items MCP surface.
      await client.callTool({
        name: "phase_state_set",
        arguments: { workItemId: "issue:42", repoRoot: phoenixPath, key: "round", value: 7 },
      });

      // Read through the ctx.state IPC surface — the other half of the split brain.
      const viaCtx = (await invoke(map, "aliasStateGet")(
        { repoRoot: phoenixPath, namespace: "workitem:issue:42", key: "round" },
        ctx,
      )) as { value: unknown };
      expect(viaCtx.value).toBe(7);

      // And the reverse direction.
      await invoke(map, "aliasStateSet")(
        { repoRoot: phoenixPath, namespace: "workitem:issue:42", key: "phase", value: "qa" },
        ctx,
      );
      const viaTool = await client.callTool({
        name: "phase_state_get",
        arguments: { workItemId: "issue:42", repoRoot: phoenixPath, key: "phase" },
      });
      expect(JSON.parse((viaTool.content as Array<{ text: string }>)[0].text).value).toBe("qa");

      // Exactly one partition holds them — not one row at 0 and one at phoenix.id.
      const partitions = db
        .getDatabase()
        .query<{ domain_id: number; n: number }, []>(
          "SELECT domain_id, count(*) AS n FROM alias_state GROUP BY domain_id",
        )
        .all();
      expect(partitions).toEqual([{ domain_id: phoenix.id, n: 2 }]);
    } finally {
      await server.stop?.();
    }
  });
});

// ── The production DomainSource, against a realistically-created session ──

describe("the daemon's real DomainSource resolves a spawn-shaped session (#3169 delta R3)", () => {
  /**
   * This is the test whose absence let R3 ship.
   *
   * Every other R3 test hands the resolver an injected `DomainSource` that always returns
   * a path. Production's returns whatever `agent_sessions` actually holds — and
   * `mcx claude spawn` sets `cwd` only, never `repoRoot`, so on a real 7-day log the
   * column the first implementation read was populated for 8 of 25,245 session-bearing
   * rows. The fixture supplied the exact field production fails to supply, so the suite
   * asserted the conclusion ("given a path, the join works") and never the premise
   * ("a path is there").
   *
   * So this builds the source the way `index.ts` does, over a real `McxDb`, against a
   * session created the way `mcx claude spawn` creates one. It fails against the
   * repo_root-only implementation.
   */
  test("a spawn-shaped session — cwd only, no repoRoot — resolves to its domain", () => {
    const { db, phoenixPath, phoenix } = setup();
    // Exactly what `mcx claude spawn` writes: cwd, no repoRoot, no worktree.
    db.upsertSession({ sessionId: "s-spawned", cwd: phoenixPath, state: "running" });

    // Premise first: assert the column the old implementation read really is empty,
    // so this test cannot pass for the wrong reason if a writer is added later.
    const row = db.getSession("s-spawned");
    expect(row?.repoRoot ?? null).toBeNull();
    expect(row?.cwd).toBe(phoenixPath);

    expect(createDomainResolver(createMcxDbDomainSource(db)).idForSession("s-spawned")).toBe(phoenix.id);
  });

  test("a nested cwd resolves by walking up, like `mcx domain which $PWD`", () => {
    const { db, phoenixPath, phoenix } = setup();
    const nested = join(phoenixPath, "packages", "core");
    mkdirSync(nested, { recursive: true });
    db.upsertSession({ sessionId: "s-nested", cwd: nested, state: "running" });

    expect(createDomainResolver(createMcxDbDomainSource(db)).idForSession("s-nested")).toBe(phoenix.id);
  });

  test("repoRoot still wins when a session actually has one", () => {
    const { db, phoenixPath, clrgPath, phoenix } = setup();
    db.upsertSession({ sessionId: "s-both", cwd: clrgPath, repoRoot: phoenixPath, state: "running" });

    expect(createDomainResolver(createMcxDbDomainSource(db)).idForSession("s-both")).toBe(phoenix.id);
  });

  // #3169 review R7: `worktree` held a NAME, never a path, and sat mid-chain in a `??`
  // expression — so its mere presence suppressed `cwd` and the session resolved to the
  // sentinel. Reachable today via `mcx agent codex spawn --worktree <name>`. This fails
  // against the `repo_root ?? worktree ?? cwd` chain.
  test("a session with a worktree NAME still resolves via cwd", () => {
    const { db, phoenixPath, phoenix } = setup();
    // Exactly what worktree-shim.ts records: a name, not a path.
    db.upsertSession({ sessionId: "s-wt", cwd: phoenixPath, worktree: "claude-mt3xvzkf", state: "running" });

    // Premise: the recorded worktree really is a bare name, so this cannot pass by accident.
    const row = db.getSession("s-wt");
    expect(row?.worktree).toBe("claude-mt3xvzkf");
    expect(row?.worktree?.startsWith("/")).toBe(false);
    expect(row?.repoRoot ?? null).toBeNull();

    expect(createDomainResolver(createMcxDbDomainSource(db)).idForSession("s-wt")).toBe(phoenix.id);
  });

  test("the production source offers only resolvable candidates — never the worktree name", () => {
    const { db, phoenixPath } = setup();
    db.upsertSession({ sessionId: "s-wt2", cwd: phoenixPath, worktree: "claude-mt3xvzkf", state: "running" });

    const candidates = createMcxDbDomainSource(db).getSessionPaths("s-wt2");
    expect(candidates).toEqual([phoenixPath]);
    expect(candidates).not.toContain("claude-mt3xvzkf");
  });

  // The root, not the instance: a non-resolving candidate must not swallow the rest.
  test("a non-resolving candidate falls through to the next one", () => {
    const { db, phoenixPath, phoenix } = setup();
    const resolver = createDomainResolver({
      listDomains: () => db.listDomains(),
      getSessionPaths: () => ["not-an-absolute-path", "/var/outside-every-domain", phoenixPath],
    });
    expect(resolver.idForSession("s-any")).toBe(phoenix.id);
  });

  test("a session outside every domain, and an unknown session, are the sentinel", () => {
    const { db, orphanPath } = setup();
    db.upsertSession({ sessionId: "s-orphan", cwd: orphanPath, state: "running" });

    const resolver = createDomainResolver(createMcxDbDomainSource(db));
    expect(resolver.idForSession("s-orphan")).toBe(NO_DOMAIN_ID);
    expect(resolver.idForSession("s-never-existed")).toBe(NO_DOMAIN_ID);
  });

  test("invalidateSession() picks up a session that was re-rooted after first observation", () => {
    const { db, phoenixPath, clrgPath, phoenix, clrg } = setup();
    db.upsertSession({ sessionId: "s-move", cwd: phoenixPath, state: "running" });
    const resolver = createDomainResolver(createMcxDbDomainSource(db));
    expect(resolver.idForSession("s-move")).toBe(phoenix.id);

    db.upsertSession({ sessionId: "s-move", repoRoot: clrgPath });
    // Memoized at first observation — this is the documented trade, not an accident.
    expect(resolver.idForSession("s-move")).toBe(phoenix.id);

    resolver.invalidateSession("s-move");
    expect(resolver.idForSession("s-move")).toBe(clrg.id);
  });
});
