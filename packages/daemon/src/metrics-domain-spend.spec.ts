import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { McxDb } from "./db/state";
import { SPEND_SOURCE_DAEMON, UNASSIGNED_DOMAIN, queryDomainSpend } from "./metrics-domain-spend";

const dbPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `mcp-domain-spend-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
        // dotw-ignore test-empty-catch: best-effort cleanup — file may already be gone
      } catch {
        /* ignore */
      }
    }
  }
  dbPaths.length = 0;
});

/**
 * `upsertSession` never sets `domain_id` (that's the pre-existing gap tracked in #3039 —
 * agent_sessions was missed when domain scoping landed). Seed rows the way a fixed writer
 * eventually will, via the raw connection `McxDb` already exposes for exactly this
 * ("modules that share this connection"), so this rollup is tested against realistic data
 * shapes rather than only the current (always-0) write path.
 */
function seedSession(
  db: McxDb,
  opts: { sessionId: string; domainId: number; model: string | null; cost: number; tokens: number; spawnedAt?: string },
): void {
  db.upsertSession({ sessionId: opts.sessionId, model: opts.model ?? undefined });
  db.updateSessionCost(opts.sessionId, opts.cost, opts.tokens);
  db.database.run("UPDATE agent_sessions SET domain_id = ?, model = ? WHERE session_id = ?", [
    opts.domainId,
    opts.model,
    opts.sessionId,
  ]);
  if (opts.spawnedAt) {
    db.database.run("UPDATE agent_sessions SET spawned_at = ? WHERE session_id = ?", [opts.spawnedAt, opts.sessionId]);
  }
}

describe("queryDomainSpend", () => {
  function createDb(): McxDb {
    const p = tmpDbPath();
    return new McxDb(p);
  }

  test("rolls up totals per domain, matching the sum of that domain's sessions", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    const clrg = db.createDomain("clrg", "/repo/clrg");

    seedSession(db, { sessionId: "p1", domainId: phoenix.id, model: "opus", cost: 1.5, tokens: 1000 });
    seedSession(db, { sessionId: "p2", domainId: phoenix.id, model: "sonnet", cost: 0.5, tokens: 500 });
    seedSession(db, { sessionId: "c1", domainId: clrg.id, model: "opus", cost: 2, tokens: 2000 });

    const result = queryDomainSpend(db);

    const phoenixTotal = result.totals.find((t) => t.domain === "phoenix");
    const clrgTotal = result.totals.find((t) => t.domain === "clrg");

    expect(phoenixTotal).toEqual({
      domain: "phoenix",
      source: SPEND_SOURCE_DAEMON,
      totalCost: 2,
      totalTokens: 1500,
      sessionCount: 2,
    });
    expect(clrgTotal).toEqual({
      domain: "clrg",
      source: SPEND_SOURCE_DAEMON,
      totalCost: 2,
      totalTokens: 2000,
      sessionCount: 1,
    });

    db.close();
  });

  test("sessions in other domains never contribute to a filtered domain's total", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    const clrg = db.createDomain("clrg", "/repo/clrg");

    seedSession(db, { sessionId: "p1", domainId: phoenix.id, model: "opus", cost: 1.5, tokens: 1000 });
    seedSession(db, { sessionId: "c1", domainId: clrg.id, model: "opus", cost: 99, tokens: 99000 });

    const result = queryDomainSpend(db, { domain: "phoenix" });

    expect(result.totals).toHaveLength(1);
    expect(result.totals[0]?.domain).toBe("phoenix");
    expect(result.totals[0]?.totalCost).toBe(1.5);
    expect(result.sessions.every((s) => s.domain === "phoenix")).toBe(true);
    expect(result.sessions.some((s) => s.sessionId === "c1")).toBe(false);

    db.close();
  });

  test("unregistered domain_id (or the default 0) rolls up under 'unassigned'", () => {
    const db = createDb();
    seedSession(db, { sessionId: "s1", domainId: NO_DOMAIN_ID, model: "opus", cost: 3, tokens: 100 });

    const result = queryDomainSpend(db);

    expect(result.totals).toHaveLength(1);
    expect(result.totals[0]?.domain).toBe(UNASSIGNED_DOMAIN);
    expect(result.totals[0]?.totalCost).toBe(3);

    db.close();
  });

  test("every row and total carries its source label", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    seedSession(db, { sessionId: "p1", domainId: phoenix.id, model: "opus", cost: 1, tokens: 10 });

    const result = queryDomainSpend(db);

    expect(result.totals[0]?.source).toBe(SPEND_SOURCE_DAEMON);
    expect(result.sessions[0]?.source).toBe(SPEND_SOURCE_DAEMON);

    db.close();
  });

  test("per-session rows carry per-model breakdown", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    seedSession(db, { sessionId: "p1", domainId: phoenix.id, model: "opus", cost: 1, tokens: 10 });
    seedSession(db, { sessionId: "p2", domainId: phoenix.id, model: "sonnet", cost: 2, tokens: 20 });

    const result = queryDomainSpend(db, { domain: "phoenix" });

    const models = result.sessions.map((s) => s.model).sort();
    expect(models).toEqual(["opus", "sonnet"]);

    db.close();
  });

  test("--since filters out sessions spawned before the cutoff", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    seedSession(db, {
      sessionId: "old",
      domainId: phoenix.id,
      model: "opus",
      cost: 1,
      tokens: 10,
      spawnedAt: "2020-01-01 00:00:00",
    });
    seedSession(db, {
      sessionId: "new",
      domainId: phoenix.id,
      model: "opus",
      cost: 2,
      tokens: 20,
      spawnedAt: "2030-01-01 00:00:00",
    });

    const cutoffMs = Date.parse("2025-01-01T00:00:00Z");
    const result = queryDomainSpend(db, { sinceMs: cutoffMs });

    expect(result.sessions.map((s) => s.sessionId)).toEqual(["new"]);
    expect(result.totals[0]?.totalCost).toBe(2);

    db.close();
  });

  test("unknown domain name returns unknownDomain:true and empty totals, not all-domains", () => {
    const db = createDb();
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    seedSession(db, { sessionId: "p1", domainId: phoenix.id, model: "opus", cost: 5, tokens: 100 });

    const result = queryDomainSpend(db, { domain: "does-not-exist" });

    expect(result.unknownDomain).toBe(true);
    expect(result.totals).toEqual([]);
    expect(result.sessions).toEqual([]);

    db.close();
  });

  test("no sessions returns empty totals and sessions, not an error", () => {
    const db = createDb();
    const result = queryDomainSpend(db);
    expect(result.totals).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.unknownDomain).toBe(false);
    db.close();
  });
});
