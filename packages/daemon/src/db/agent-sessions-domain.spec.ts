/**
 * `agent_sessions.domain_id` has to be WRITTEN and READ BACK, not merely declared.
 *
 * #3034 added the column and an index on it; nothing populated either. A partition
 * column no writer touches is worse than no column: every row reads `0`, so a
 * domain-scoped query answers "no sessions here" rather than "not recorded", and
 * the index makes the lie fast. These tests assert the round trip — the same shape
 * of gap that `work_item_transitions.domain_id` was found to have on this base.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { StateDb } from "./state";

function tmpDbPath(): string {
  return join(tmpdir(), `mcp-cli-sessions-domain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("agent_sessions domain persistence", () => {
  const paths: string[] = [];
  const dbs: StateDb[] = [];

  function open(): StateDb {
    const path = tmpDbPath();
    paths.push(path);
    const db = new StateDb(path);
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const path of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${path}${suffix}`);
          // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
        } catch {
          /* ignore */
        }
      }
    }
  });

  test("a domain written at spawn survives the read back", () => {
    const db = open();
    db.upsertSession({ sessionId: "s1", cwd: "/repo/a", domainId: 7 });
    expect(db.getSession("s1")?.domainId).toBe(7);
    expect(db.listSessions().find((s) => s.sessionId === "s1")?.domainId).toBe(7);
  });

  test("a session spawned outside every domain records the sentinel, not null", () => {
    const db = open();
    db.upsertSession({ sessionId: "s1", cwd: "/repo/a" });
    expect(db.getSession("s1")?.domainId).toBe(NO_DOMAIN_ID);
  });

  test("a partial follow-up upsert does not erase the recorded domain", () => {
    // The spawn path posts `db:upsert` twice: once with the session's fields, then
    // again with only { sessionId, pid, pidStartTime }. If the second write bound a
    // default 0 the domain would be lost moments after being resolved — the column
    // would still be non-empty in a fresh test and always 0 in production.
    const db = open();
    db.upsertSession({ sessionId: "s1", cwd: "/repo/a", domainId: 7 });
    db.upsertSession({ sessionId: "s1", pid: 4242, pidStartTime: 1 });

    const row = db.getSession("s1");
    expect(row?.domainId).toBe(7);
    expect(row?.pid).toBe(4242);
  });

  test("an explicit domainId of 0 cannot stomp a resolved domain", () => {
    // The spawn-side idiom in all five workers is
    //   `typeof args.domainId === "number" ? args.domainId : NO_DOMAIN_ID`
    // which turns "unknown" into a literal 0 — a value COALESCE cannot distinguish
    // from an intentional write. The SQL uses CASE so the invariant "0 never
    // overwrites a resolved domain" is structural rather than a convention every
    // future caller has to remember. Re-homing to 0 is done by an explicit UPDATE.
    const db = open();
    db.upsertSession({ sessionId: "s1", domainId: 7 });
    db.upsertSession({ sessionId: "s1", domainId: NO_DOMAIN_ID, state: "active" });

    const row = db.getSession("s1");
    expect(row?.domainId).toBe(7);
    expect(row?.state).toBe("active");
  });

  test("a later upsert CAN move a session to another domain when one is supplied", () => {
    const db = open();
    db.upsertSession({ sessionId: "s1", domainId: 7 });
    db.upsertSession({ sessionId: "s1", domainId: 9 });
    expect(db.getSession("s1")?.domainId).toBe(9);
  });

  test("rows from different domains are distinguishable in a listing", () => {
    // The restore path (`claude-server.ts`) rebuilds live sessions from exactly
    // this listing, so a listing that flattens domains re-homes every survivor of
    // a daemon restart to domain 0.
    const db = open();
    db.upsertSession({ sessionId: "a", domainId: 1 });
    db.upsertSession({ sessionId: "b", domainId: 2 });
    db.upsertSession({ sessionId: "c" });

    const byId = new Map(db.listSessions().map((s) => [s.sessionId, s.domainId]));
    expect(byId.get("a")).toBe(1);
    expect(byId.get("b")).toBe(2);
    expect(byId.get("c")).toBe(NO_DOMAIN_ID);
  });

  test("domain_id counts as a dependent when a domain is deleted", () => {
    const db = open();
    const d = db.createDomain("phoenix", "/tmp");
    db.upsertSession({ sessionId: "s1", domainId: d.id });
    expect(db.countDomainDependents(d.id)).toContainEqual({ table: "agent_sessions", rows: 1 });
  });
});

describe("the upgrade path — adopting pre-domain sessions (#3039 review 3)", () => {
  const paths: string[] = [];
  const dbs: StateDb[] = [];

  function open(): StateDb {
    const path = tmpDbPath();
    paths.push(path);
    const db = new StateDb(path);
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const path of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${path}${suffix}`);
          // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
        } catch {
          /* ignore */
        }
      }
    }
  });

  test("registering a domain ADOPTS the sessions already standing in it", () => {
    // Without this the upgrade blinds every existing user: `importLegacyState` turns
    // their `~/.mcp-cli/scopes/` sidecars into domains automatically on the first
    // start, their sessions stay at domain 0, and exact-equality filtering excludes 0.
    // `mcx claude ls` goes empty on a box full of live sessions — and so does
    // `mcx claude bye --all --scoped`, so the daemon can be shut down on top of them.
    const db = open();
    const root = mkdtempSync(join(tmpdir(), "mcx-adopt-"));
    try {
      db.upsertSession({ sessionId: "pre-existing", cwd: join(root, "sub") });
      expect(db.getSession("pre-existing")?.domainId).toBe(NO_DOMAIN_ID);

      const domain = db.createDomain("phoenix", root);

      expect(db.getSession("pre-existing")?.domainId).toBe(domain.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adoption falls back to repo_root when cwd is absent", () => {
    const db = open();
    const root = mkdtempSync(join(tmpdir(), "mcx-adopt-repo-"));
    try {
      db.upsertSession({ sessionId: "s", repoRoot: root });
      const domain = db.createDomain("phoenix", root);
      expect(db.getSession("s")?.domainId).toBe(domain.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sessions outside the new domain are left alone, not swept in", () => {
    const db = open();
    const inside = mkdtempSync(join(tmpdir(), "mcx-adopt-in-"));
    const outside = mkdtempSync(join(tmpdir(), "mcx-adopt-out-"));
    try {
      db.upsertSession({ sessionId: "in", cwd: inside });
      db.upsertSession({ sessionId: "out", cwd: outside });
      const domain = db.createDomain("phoenix", inside);

      expect(db.getSession("in")?.domainId).toBe(domain.id);
      expect(db.getSession("out")?.domainId).toBe(NO_DOMAIN_ID);
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("adoption is idempotent and never re-homes an already-assigned session", () => {
    const db = open();
    const outer = mkdtempSync(join(tmpdir(), "mcx-adopt-outer-"));
    try {
      const inner = join(outer, "inner");
      mkdirSync(inner, { recursive: true });
      const innerDomain = db.createDomain("inner", inner);
      db.upsertSession({ sessionId: "s", cwd: inner, domainId: innerDomain.id });

      // Registering an OUTER domain must not steal a session already owned by the
      // inner one — only `domain_id = 0` rows are candidates.
      db.createDomain("outer", outer);
      expect(db.getSession("s")?.domainId).toBe(innerDomain.id);
      expect(db.adoptSessionsIntoDomains()).toBe(0);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("a malformed stored path does not abort the rest of the backfill", () => {
    const db = open();
    const root = mkdtempSync(join(tmpdir(), "mcx-adopt-mixed-"));
    try {
      db.upsertSession({ sessionId: "bad", cwd: "relative/path" });
      db.upsertSession({ sessionId: "good", cwd: root });
      const domain = db.createDomain("phoenix", root);

      expect(db.getSession("good")?.domainId).toBe(domain.id);
      expect(db.getSession("bad")?.domainId).toBe(NO_DOMAIN_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("deleteDomain must not orphan live processes (#3039 review 7)", () => {
  const paths: string[] = [];
  const dbs: StateDb[] = [];

  function open(): StateDb {
    const path = tmpDbPath();
    paths.push(path);
    const db = new StateDb(path);
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const path of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${path}${suffix}`);
          // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
        } catch {
          /* ignore */
        }
      }
    }
  });

  test("a cascade re-homes LIVE sessions instead of deleting them", () => {
    // A live session row is the daemon's only handle on a running child:
    // `orphan-reaper` finds children via listSessions(true), and `bye` needs the row.
    // Deleting it leaves an unreapable, un-endable process. This PR is what armed the
    // hazard — before domain_id had a writer, every row was 0 and never matched.
    const db = open();
    const root = mkdtempSync(join(tmpdir(), "mcx-del-"));
    try {
      const domain = db.createDomain("phoenix", root);
      db.upsertSession({ sessionId: "live", cwd: root, domainId: domain.id });
      db.upsertSession({ sessionId: "ended", cwd: root, domainId: domain.id });
      db.endSession("ended");

      expect(db.deleteDomain("phoenix", { cascade: true })).toBe(true);

      const live = db.getSession("live");
      expect(live).not.toBeNull();
      expect(live?.domainId).toBe(NO_DOMAIN_ID);
      expect(live?.endedAt).toBeNull();

      // History cascades as the operator asked.
      expect(db.getSession("ended")).toBeNull();
      expect(db.getDomainByName("phoenix")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
