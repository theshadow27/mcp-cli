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
import { unlinkSync } from "node:fs";
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
