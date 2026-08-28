/**
 * The partition-closing hazard, and the adoption that closes it (#3040).
 *
 * Driven with a domain REGISTERED and a caller standing both inside and outside it,
 * because a fresh box where `listDomains()` is empty makes every one of these pass
 * vacuously — which is exactly how this class of defect stays invisible.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { createDomainResolver, createMcxDbDomainSource } from "../domain-resolver";
import { EventLog } from "../event-log";
import { adoptUnassignedDomains } from "./adopt-domains";
import { McxDb } from "./state";

const dirs: string[] = [];
const open: McxDb[] = [];

afterEach(() => {
  for (const d of open) d.close();
  open.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "mcx-adopt-"));
  dirs.push(home);
  const inside = join(home, "myrepo");
  const outside = join(home, "elsewhere");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const db = new McxDb(join(home, "mcx.db"));
  open.push(db);
  // `monitor_events` belongs to EventLog's migration, not McxDb's. Without it every
  // adoption call here logged "no such table" and silently exercised `alias_state` alone,
  // leaving the `json_extract(payload, '$.repoRoot')` root expression uncovered (#3213).
  new EventLog(db.getDatabase());
  return { db, inside, outside };
}

/** Append a raw sentinel-partition event whose payload carries `repoRoot`. */
function insertEvent(db: McxDb, repoRoot: string): void {
  db.getDatabase().run(
    `INSERT INTO monitor_events (ts, src, event, category, domain_id, payload)
     VALUES (?, 'daemon', 'server.ready', 'server', ?, ?)`,
    [new Date(0).toISOString(), NO_DOMAIN_ID, JSON.stringify({ repoRoot })],
  );
}

const silent = () => {};

describe("state written before a domain existed", () => {
  test("is reachable again after adoption — the hazard, and the fix", () => {
    const { db, inside } = setup();

    // Pre-domain: a phase script writes ctx.state. Resolves to the sentinel.
    const before = createDomainResolver(createMcxDbDomainSource(db));
    expect(before.idForPath(inside)).toBe(NO_DOMAIN_ID);
    db.setAliasState(inside, "workitem:#42", "round", 3, NO_DOMAIN_ID);

    // A domain appears with no user action — importScopesAsDomains does this at boot
    // from any ~/.mcp-cli/scopes/*.json sidecar.
    const domain = db.createDomain("myrepo", inside);

    // Without adoption the read is silently empty. This is the premise: assert the
    // hazard is real, so the fix below cannot pass for the wrong reason.
    expect(db.getAliasState(inside, "workitem:#42", "round", domain.id)).toBeUndefined();
    expect(db.getAliasState(inside, "workitem:#42", "round", NO_DOMAIN_ID)).toBe(3);

    // Boot-time adoption.
    const result = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(result.stamped).toBeGreaterThan(0);

    // The next daemon boot resolves a real domain and finds the value.
    const after = createDomainResolver(createMcxDbDomainSource(db));
    expect(db.getAliasState(inside, "workitem:#42", "round", after.idForPath(inside))).toBe(3);
  });

  test("a nested repo root inside the domain is adopted too", () => {
    const { db, inside } = setup();
    const nested = join(inside, "packages", "core");
    mkdirSync(nested, { recursive: true });
    db.setAliasState(nested, "ns", "k", "v", NO_DOMAIN_ID);
    const domain = db.createDomain("myrepo", inside);

    adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(db.getAliasState(nested, "ns", "k", domain.id)).toBe("v");
  });

  test("a caller OUTSIDE every domain is untouched and still reads its own state", () => {
    const { db, inside, outside } = setup();
    db.setAliasState(outside, "ns", "k", "mine", NO_DOMAIN_ID);
    db.createDomain("myrepo", inside);

    adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);

    const resolver = createDomainResolver(createMcxDbDomainSource(db));
    expect(resolver.idForPath(outside)).toBe(NO_DOMAIN_ID);
    expect(db.getAliasState(outside, "ns", "k", NO_DOMAIN_ID)).toBe("mine");
  });

  test("adoption is idempotent — a second boot changes nothing", () => {
    const { db, inside } = setup();
    db.setAliasState(inside, "ns", "k", "v", NO_DOMAIN_ID);
    db.createDomain("myrepo", inside);

    const first = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    const second = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(first.stamped).toBeGreaterThan(0);
    expect(second.stamped).toBe(0);
    expect(second.collided).toBe(0);
  });

  test("with no domains registered, adoption is a no-op", () => {
    const { db, inside } = setup();
    db.setAliasState(inside, "ns", "k", "v", NO_DOMAIN_ID);
    expect(adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent)).toEqual({ stamped: 0, collided: 0 });
    expect(db.getAliasState(inside, "ns", "k", NO_DOMAIN_ID)).toBe("v");
  });

  test("a collision leaves the row rather than overwriting the domain's own value", () => {
    const { db, inside } = setup();
    const domain = db.createDomain("myrepo", inside);
    // The domain-scoped writer already wrote this key...
    db.setAliasState(inside, "ns", "k", "current", domain.id);
    // ...and an older un-domained row exists for the same key.
    db.getDatabase().run(
      "INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)",
      [NO_DOMAIN_ID, inside, "ns", "k", '"stale"'],
    );

    const result = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(result.collided).toBe(1);
    // The live value wins; the stale row is left behind, not merged over it.
    expect(db.getAliasState(inside, "ns", "k", domain.id)).toBe("current");
  });

  test("one colliding key does not strand its non-colliding siblings", () => {
    // The regression this closes (#3213): adoption UPDATEs per ROOT while alias_state's
    // primary key is per KEY, so under bare `UPDATE` a single conflicting key aborted the
    // whole statement and left every sibling under that root on the sentinel. Three keys
    // with exactly one collision is the smallest fixture that can tell the two apart — a
    // one-key fixture passes under both semantics.
    const { db, inside } = setup();
    const domain = db.createDomain("myrepo", inside);
    db.setAliasState(inside, "workitem:#42", "round", 1, domain.id);

    const raw = db.getDatabase();
    for (const [key, valueJson] of [
      ["round", "3"],
      ["scrutiny", '"high"'],
      ["phase", '"qa"'],
    ]) {
      raw.run("INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)", [
        NO_DOMAIN_ID,
        inside,
        "workitem:#42",
        key,
        valueJson,
      ]);
    }

    const result = adoptUnassignedDomains(raw, db.listDomains(), silent);
    expect(result).toEqual({ stamped: 2, collided: 1 });

    // The two keys the domain never held are reachable...
    expect(db.getAliasState(inside, "workitem:#42", "scrutiny", domain.id)).toBe("high");
    expect(db.getAliasState(inside, "workitem:#42", "phase", domain.id)).toBe("qa");
    // ...and only the genuine collision stays behind, live value intact.
    expect(db.getAliasState(inside, "workitem:#42", "round", domain.id)).toBe(1);
    expect(db.getAliasState(inside, "workitem:#42", "round", NO_DOMAIN_ID)).toBe(3);
  });

  test("monitor_events rows are adopted by the repoRoot in their payload", () => {
    const { db, inside, outside } = setup();
    insertEvent(db, inside);
    insertEvent(db, outside);
    const domain = db.createDomain("myrepo", inside);

    const result = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(result).toEqual({ stamped: 1, collided: 0 });

    // seq is the primary key, so a domain move can never conflict here — but the row must
    // land on the domain its payload root resolves to, and the outsider must not move.
    const rows = db
      .getDatabase()
      .query<{ domain_id: number; payload: string }, []>("SELECT domain_id, payload FROM monitor_events ORDER BY seq")
      .all();
    expect(rows).toEqual([
      { domain_id: domain.id, payload: JSON.stringify({ repoRoot: inside }) },
      { domain_id: NO_DOMAIN_ID, payload: JSON.stringify({ repoRoot: outside }) },
    ]);
  });
});
