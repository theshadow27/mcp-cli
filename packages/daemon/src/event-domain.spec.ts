import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { WorkItemDb } from "./db/work-items";
import { createDomainResolver } from "./domain-resolver";
import { EventBus } from "./event-bus";
import { createEventDomainStamper } from "./event-domain";
import { EventLog } from "./event-log";

/*
 * Fixture paths use `/mcx-test/...` for the same reason event-bus.spec.ts does: a root
 * that resolves to itself on every platform, so the canonicalization the resolver applies
 * cannot make the event's spelling and the domain row's spelling disagree.
 */
const ALPHA = "/mcx-test/alpha";
const BRAVO = "/mcx-test/bravo";

const DOMAINS = [
  { id: 1, name: "alpha", host: null, path: ALPHA, createdAt: "2026-08-26T00:00:00.000Z" },
  { id: 2, name: "bravo", host: null, path: BRAVO, createdAt: "2026-08-26T00:00:00.000Z" },
];

function resolver() {
  return createDomainResolver({ getSessionPaths: () => [], listDomains: () => DOMAINS });
}

/** A stamper over a real WorkItemDb, plus the handles a test needs to seed and assert. */
function fixture(daemonRepoRoot = ALPHA) {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  const wdb = new WorkItemDb(db);
  const items = wdb.acrossDomains();
  const stamper = createEventDomainStamper({
    lookup: {
      byId: (itemId) => items.getWorkItem(itemId),
      byPr: (prNumber) => items.findByPr(prNumber)[0] ?? null,
    },
    daemonRepoRoot,
  });
  return { db, wdb, items, stamper };
}

function ciEvent(over: Partial<MonitorEventInput> = {}): MonitorEventInput {
  return { src: "daemon.work-item-poller", event: "ci.finished", category: "ci", ...over };
}

describe("createEventDomainStamper", () => {
  test("stamps the work item's own domain, not the daemon's, by workItemId", () => {
    const { wdb, stamper } = fixture();
    const item = wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    expect(stamper.stamp(ciEvent({ workItemId: item.id, prNumber: 42 }))).toMatchObject({ domainId: 2 });
  });

  test("resolves by prNumber when the event carries no workItemId", () => {
    const { wdb, stamper } = fixture();
    wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    expect(stamper.stamp(ciEvent({ prNumber: 42 }))).toMatchObject({ domainId: 2 });
  });

  test("workItemId wins over prNumber — a PR number is unique only within a domain", () => {
    const { wdb, stamper } = fixture();
    wdb.forDomain(1).createWorkItem({ prNumber: 7 });
    const bravoItem = wdb.forDomain(2).createWorkItem({ prNumber: 7 });

    const stamped = stamper.stamp(ciEvent({ workItemId: bravoItem.id, prNumber: 7 }));
    expect(stamped.domainId).toBe(2);
  });

  test("an event naming no work item falls back to the daemon's root, not un-domained", () => {
    const { stamper } = fixture();
    const stamped = stamper.stamp(ciEvent());
    expect(stamped.domainId).toBeUndefined();
    expect(stamped.repoRoot).toBe(ALPHA);
  });

  test("an unknown work item falls back to the daemon's root", () => {
    const { stamper } = fixture();
    expect(stamper.stamp(ciEvent({ workItemId: "d9:#404" })).repoRoot).toBe(ALPHA);
  });

  test("an unassigned work item resolves to the sentinel, so the fallback applies", () => {
    const { wdb, stamper } = fixture();
    const item = wdb.forDomain(NO_DOMAIN_ID).createWorkItem({ prNumber: 5 });
    expect(stamper.domainIdFor(ciEvent({ workItemId: item.id }))).toBe(NO_DOMAIN_ID);
    expect(stamper.stamp(ciEvent({ workItemId: item.id })).repoRoot).toBe(ALPHA);
  });

  test("a producer that already declared an identity is left untouched", () => {
    const { wdb, stamper } = fixture();
    const item = wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    // domainId — the producer was handed a domain and says so.
    expect(stamper.stamp(ciEvent({ workItemId: item.id, domainId: 9 }))).toMatchObject({ domainId: 9 });
    // repoRoot — the producer supplied its own path.
    const withRoot = stamper.stamp(ciEvent({ workItemId: item.id, repoRoot: BRAVO }));
    expect(withRoot.domainId).toBeUndefined();
    expect(withRoot.repoRoot).toBe(BRAVO);
    // sessionId — the bus resolves the session's own domain; stamping the daemon's root
    // over it would attribute another domain's session to this one.
    const withSession = stamper.stamp(ciEvent({ workItemId: item.id, sessionId: "s1" }));
    expect(withSession.domainId).toBeUndefined();
    expect(withSession.repoRoot).toBeUndefined();
  });

  test("does not mutate the input event", () => {
    const { wdb, stamper } = fixture();
    const item = wdb.forDomain(2).createWorkItem({ prNumber: 42 });
    const input = ciEvent({ workItemId: item.id });
    stamper.stamp(input);
    expect(input.domainId).toBeUndefined();
  });
});

// ── End to end: the #3352 repro, through the real bus, log and resolver ──

describe("poller events reach the durable log in the work item's domain (#3352)", () => {
  /** Everything the daemon wires between a poller and `monitor_events`, minus the poller. */
  function daemon(daemonRepoRoot = ALPHA) {
    const { db, wdb, items, stamper } = fixture(daemonRepoRoot);
    const domains = resolver();
    const log = new EventLog(db);
    const bus = new EventBus(log, Date.now, domains);
    // The wiring under test, copied in shape from index.ts's `claudeServer.onMonitorEvent`.
    const onMonitorEvent = (input: MonitorEventInput) =>
      bus.publish(input.category === "work_item" || input.category === "ci" ? stamper.stamp(input) : input);
    return { db, wdb, items, log, bus, domains, onMonitorEvent };
  }

  function rows(db: Database) {
    return db
      .query<{ event: string; domain_id: number; name: string | null }, []>(
        "SELECT event, domain_id, json_extract(payload, '$.domain') AS name FROM monitor_events ORDER BY seq",
      )
      .all();
  }

  test("a PR in another domain is not attributed to the daemon's own", () => {
    const { db, wdb, onMonitorEvent, log, domains } = daemon(ALPHA);
    const item = wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    onMonitorEvent({
      src: "daemon.work-item-poller",
      event: "checks.passed",
      category: "work_item",
      workItemId: item.id,
      prNumber: 42,
    });

    expect(rows(db)).toEqual([{ event: "checks.passed", domain_id: 2, name: "bravo" }]);
    // bravo can see its own PR's checks; alpha does not see another project's.
    const nameForId = (id: number) => domains.nameForId(id);
    expect(log.getSince(0, 100, { domainId: 2, nameForId })).toHaveLength(1);
    expect(log.getSince(0, 100, { domainId: 1, nameForId })).toHaveLength(0);
  });

  test("the name and the column agree even when the daemon's cwd is outside every domain", () => {
    const { db, wdb, onMonitorEvent } = daemon("/mcx-elsewhere/nowhere");
    const item = wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    onMonitorEvent({
      src: "daemon.work-item-poller",
      event: "pr.merged",
      category: "work_item",
      workItemId: item.id,
    });
    // ...and for an event that resolves to no item at all, which is genuinely un-domained.
    onMonitorEvent({ src: "daemon.work-item-poller", event: "pr.opened", category: "work_item", prNumber: 999 });

    expect(rows(db)).toEqual([
      { event: "pr.merged", domain_id: 2, name: "bravo" },
      { event: "pr.opened", domain_id: NO_DOMAIN_ID, name: null },
    ]);
  });

  test("a producer-supplied domain name never outlives a disagreeing column", () => {
    const { db, wdb, onMonitorEvent } = daemon("/mcx-elsewhere/nowhere");
    wdb.forDomain(2).createWorkItem({ prNumber: 42 });

    // The pre-#3352 shape: a name and nothing the bus can resolve it from. The live
    // filter matches names and replay matches the column, so a row carrying one without
    // the other is visible to exactly one of them — persist neither half of that.
    onMonitorEvent({
      src: "daemon.work-item-poller",
      event: "pr.closed",
      category: "work_item",
      domain: "bravo",
    });

    expect(rows(db)).toEqual([{ event: "pr.closed", domain_id: NO_DOMAIN_ID, name: null }]);
  });

  test("un-domained daemon traffic still reaches the log, without borrowing a domain", () => {
    const { db, bus } = daemon(ALPHA);
    bus.publish({ src: "daemon", event: "daemon.restarted", category: "daemon" });
    expect(rows(db)).toEqual([{ event: "daemon.restarted", domain_id: NO_DOMAIN_ID, name: null }]);
  });
});
