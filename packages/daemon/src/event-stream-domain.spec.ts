/**
 * `GET /events?domain=<name>` — the wire behind `mcx monitor -d` (#3040).
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import { createDomainResolver } from "./domain-resolver";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import { EventStreamServer } from "./event-stream";
import type { ServerPool } from "./server-pool";

/*
 * Fixture paths use `/mcx-test/...`, a root that exists on no platform, rather than
 * `/tmp` or `/home`. These tests never touch the filesystem, but the code under test
 * canonicalizes the paths it is handed — and on macOS `/tmp` and `/var` are symlinks and
 * `/home` is a firmlink, so a query built on one of those resolves (`/private/tmp/...`)
 * while the hand-built domain row beside it does not. That asymmetry is an artifact of
 * the fixture, not of the rule being tested: production stores domain paths canonical.
 * A root that resolves to itself everywhere keeps both sides in the same spelling.
 */

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function domain(id: number, name: string, path: string): Domain {
  return { id, name, host: null, path, createdAt: "2026-08-22T00:00:00.000Z" };
}

const RESOLVER = createDomainResolver({
  listDomains: () => [domain(3, "phoenix", "/mcx-test/phoenix"), domain(7, "clrg", "/mcx-test/clrg")],
  getSessionPaths: () => [],
});

const servers: EventStreamServer[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const s of servers) s.dispose();
  servers.length = 0;
  for (const d of dbs) d.close();
  dbs.length = 0;
});

function setup(): { server: EventStreamServer; bus: EventBus } {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  dbs.push(db);
  const log = new EventLog(db);
  const bus = new EventBus(log, Date.now, RESOLVER);
  const server = new EventStreamServer(bus, {} as ServerPool, silentLogger, 30_000, log);
  servers.push(server);
  return { server, bus };
}

/** Read NDJSON lines until `want` events have been seen, then cancel the stream. */
async function drain(res: Response, want: number): Promise<Record<string, unknown>[]> {
  const body = res.body;
  if (!body) throw new Error("expected a response body");
  const out: Record<string, unknown>[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (out.length < want) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.event === "heartbeat" || parsed.t === "gap") continue;
        out.push(parsed);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

describe("GET /events domain scoping", () => {
  // An empty stream and a quiet domain are indistinguishable from the outside, which is
  // the worst possible answer for a monitoring surface. A typo must be an error.
  test("an unregistered domain name is a 400, not an empty stream", () => {
    const { server } = setup();
    const res = server.handleEventsNDJSON(new URL("http://localhost/events?domain=typo"));
    expect(res.status).toBe(400);
  });

  test("a registered domain is accepted", async () => {
    const { server } = setup();
    const res = server.handleEventsNDJSON(new URL("http://localhost/events?domain=phoenix"));
    expect(res.status).toBe(200);
    await res.body?.cancel().catch(() => {});
  });

  test("replay with ?domain= returns only that domain's events", async () => {
    const { server, bus } = setup();
    bus.publish({ src: "daemon", event: "pr.opened", category: "work_item", repoRoot: "/mcx-test/phoenix" });
    bus.publish({ src: "daemon", event: "pr.merged", category: "work_item", repoRoot: "/mcx-test/clrg" });
    bus.publish({ src: "daemon", event: "pr.closed", category: "work_item", repoRoot: "/mcx-test/phoenix/pkg" });
    bus.publish({ src: "daemon", event: "mail.sent", category: "mail" });

    const res = server.handleEventsNDJSON(new URL("http://localhost/events?since=0&domain=phoenix"));
    expect(res.status).toBe(200);
    const got = await drain(res, 2);
    expect(got.map((e) => e.event)).toEqual(["pr.opened", "pr.closed"]);
    expect(got.every((e) => e.domainId === 3 && e.domain === "phoenix")).toBe(true);
  });

  test("replay with no ?domain= returns every domain — the daemon-wide stream", async () => {
    const { server, bus } = setup();
    bus.publish({ src: "daemon", event: "pr.opened", category: "work_item", repoRoot: "/mcx-test/phoenix" });
    bus.publish({ src: "daemon", event: "pr.merged", category: "work_item", repoRoot: "/mcx-test/clrg" });
    bus.publish({ src: "daemon", event: "mail.sent", category: "mail" });

    const res = server.handleEventsNDJSON(new URL("http://localhost/events?since=0"));
    const got = await drain(res, 3);
    expect(got.map((e) => e.event)).toEqual(["pr.opened", "pr.merged", "mail.sent"]);
    expect(got.map((e) => e.domainId)).toEqual([3, 7, NO_DOMAIN_ID]);
  });

  // #3040 review R2: getSince overlaid the id but not the NAME, and shouldDeliver matches
  // on the name. So a row whose domain_id was set by UPDATE (everything the import stamps)
  // passed the SQL filter and was then silently dropped by the name matcher. This test
  // fails without the name overlay: the stream yields nothing.
  test("a row stamped by UPDATE — id but no name — still reaches a -d subscriber", async () => {
    const { server, bus } = setup();
    const db = dbs[dbs.length - 1];
    if (!db) throw new Error("expected a database");

    // Publish un-domained, then stamp the domain the way the import does: by UPDATE.
    // The payload JSON therefore has no `domain` name anywhere in it.
    bus.publish({ src: "daemon", event: "pr.merged", category: "work_item" });
    db.run("UPDATE monitor_events SET domain_id = 3");
    const stored = db.query<{ payload: string }, []>("SELECT payload FROM monitor_events").get();
    expect(JSON.parse(stored?.payload ?? "{}").domain).toBeUndefined();

    const res = server.handleEventsNDJSON(new URL("http://localhost/events?since=0&domain=phoenix"));
    expect(res.status).toBe(200);
    const got = await drain(res, 1);
    expect(got.map((e) => e.event)).toEqual(["pr.merged"]);
    expect(got[0]?.domain).toBe("phoenix");
    expect(got[0]?.domainId).toBe(3);
  });

  test("live events are filtered by domain too, not just replay", async () => {
    const { server, bus } = setup();
    const res = server.handleEventsNDJSON(new URL("http://localhost/events?domain=clrg"));
    expect(res.status).toBe(200);

    const drained = drain(res, 1);
    bus.publish({ src: "daemon", event: "pr.opened", category: "work_item", repoRoot: "/mcx-test/phoenix" });
    bus.publish({ src: "daemon", event: "mail.sent", category: "mail" });
    bus.publish({ src: "daemon", event: "pr.merged", category: "work_item", repoRoot: "/mcx-test/clrg" });

    const got = await drained;
    expect(got.map((e) => e.event)).toEqual(["pr.merged"]);
    expect(got[0]?.domain).toBe("clrg");
  });
});
