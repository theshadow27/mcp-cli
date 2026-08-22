/**
 * `ctx.state` is domain-scoped end to end (#3040).
 *
 * Deliberately against a **real** `StateDb` and the **real** IPC handlers rather than the
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
import { StateDb } from "../db/state";
import { WorkItemDb } from "../db/work-items";
import { createDomainResolver } from "../domain-resolver";
import type { RequestHandler } from "../handler-types";
import { WorkItemHandlers } from "./work-item";

const ctx = {} as never;

const tempDirs: string[] = [];
const openDbs: StateDb[] = [];

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
  const db = new StateDb(dbPath);
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
    createDomainResolver(db),
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
