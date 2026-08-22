import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Domain, DomainImportResult, DomainRemoveResult, DomainWhichResult, IpcMethod } from "@mcp-cli/core";
import { IMPORT_MARKER_KEY, nonEmptyImportedTables } from "../db/import-legacy";
import { StateDb } from "../db/state";
import { WorkItemDb } from "../db/work-items";
import { migrateDerivedCursor } from "../derived-events";
import { EventLog } from "../event-log";
import type { RequestHandler } from "../handler-types";
import { DomainHandlers } from "./domain";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

describe("DomainHandlers", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const o of open) o.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "mcx-domain-handlers-"));
    dirs.push(dir);
    return dir;
  }

  function setup(): { db: StateDb; handlers: Map<IpcMethod, RequestHandler>; dir: string } {
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    // The dependent tables live in other schema consumers; `rm` must count their rows.
    new WorkItemDb(db.database);
    new EventLog(db.database);
    migrateDerivedCursor(db.database);
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(db).register(handlers);
    return { db, handlers, dir };
  }

  const ctx = {} as never;

  test("add stores host and path separately for the [host:]path form", async () => {
    const { handlers } = setup();
    const local = (await invoke(handlers, "domainAdd")({ name: "local", path: "/srv/local" }, ctx)) as Domain;
    const remote = (await invoke(handlers, "domainAdd")(
      { name: "remote", host: "boxen0010", path: "~/github/phoenix" },
      ctx,
    )) as Domain;

    expect(local.host).toBeNull();
    expect(local.path).toBe("/srv/local");
    expect(remote.host).toBe("boxen0010");
    // Verbatim: `~` there is that host's home, and this filesystem has no say.
    expect(remote.path).toBe("~/github/phoenix");
  });

  test("add rejects a relative local path at the protocol boundary", async () => {
    const { handlers } = setup();
    await expect(invoke(handlers, "domainAdd")({ name: "rel", path: "relative/path" }, ctx)).rejects.toThrow();
    await expect(invoke(handlers, "domainAdd")({ name: "tilde", path: "~/work" }, ctx)).rejects.toThrow();
  });

  test("add rejects a duplicate name and names where the existing one lives", async () => {
    const { handlers } = setup();
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx);
    await expect(invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/other" }, ctx)).rejects.toThrow(
      /already exists at \/srv\/phoenix/,
    );
  });

  test("add rejects a location already owned, naming the owner", async () => {
    const { handlers } = setup();
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx);
    await expect(invoke(handlers, "domainAdd")({ name: "second", path: "/srv/phoenix" }, ctx)).rejects.toThrow(
      /already domain "phoenix"/,
    );
  });

  test("a host-bound path does not collide with the same local path", async () => {
    const { handlers } = setup();
    await invoke(handlers, "domainAdd")({ name: "here", path: "/srv/app" }, ctx);
    const there = (await invoke(handlers, "domainAdd")(
      { name: "there", host: "boxen0010", path: "/srv/app" },
      ctx,
    )) as Domain;
    expect(there.host).toBe("boxen0010");
  });

  test("which resolves from inside the path and reports the registered names on a miss", async () => {
    const { handlers, dir } = setup();
    await invoke(handlers, "domainAdd")({ name: "proj", path: dir }, ctx);

    const hit = (await invoke(handlers, "domainWhich")(
      { path: join(dir, "packages", "core") },
      ctx,
    )) as DomainWhichResult;
    expect(hit.domain?.name).toBe("proj");

    const miss = (await invoke(handlers, "domainWhich")({ path: "/definitely/elsewhere" }, ctx)) as DomainWhichResult;
    expect(miss.domain).toBeNull();
    expect(miss.registered).toEqual(["proj"]);
  });

  test("which refuses a relative path rather than anchoring it on the daemon's cwd", async () => {
    const { handlers } = setup();
    await expect(invoke(handlers, "domainWhich")({ path: "packages/core" }, ctx)).rejects.toThrow();
  });

  test("rename changes the name only — id, path and every domain_id survive", async () => {
    const { db, handlers } = setup();
    const before = (await invoke(handlers, "domainAdd")({ name: "old", path: "/srv/app" }, ctx)) as Domain;
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [before.id]);

    const after = (await invoke(handlers, "domainRename")({ from: "old", to: "new" }, ctx)) as Domain;
    expect(after.id).toBe(before.id);
    expect(after.path).toBe(before.path);
    expect(after.host).toBe(before.host);

    // The reference, not just the row: the mail row still points at this domain.
    expect(db.countDomainDependents(after.id)).toEqual([{ table: "mail", rows: 1 }]);
    expect(db.getDomainByName("old")).toBeNull();
  });

  test("rename refuses an unknown source and an occupied target", async () => {
    const { handlers } = setup();
    await invoke(handlers, "domainAdd")({ name: "a", path: "/srv/a" }, ctx);
    await invoke(handlers, "domainAdd")({ name: "b", path: "/srv/b" }, ctx);
    await expect(invoke(handlers, "domainRename")({ from: "nope", to: "c" }, ctx)).rejects.toThrow(/no domain named/);
    await expect(invoke(handlers, "domainRename")({ from: "a", to: "b" }, ctx)).rejects.toThrow(/already exists/);
  });

  test("rm REFUSES while dependents exist — and leaves every row where it was", async () => {
    const { db, handlers } = setup();
    const domain = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx)) as Domain;
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [domain.id]);
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'c', 'd', 'yo')", [domain.id]);

    const refused = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx)) as DomainRemoveResult;
    expect(refused.found).toBe(true);
    expect(refused.removed).toBe(false);
    expect(refused.dependents).toEqual([{ table: "mail", rows: 2 }]);

    // The assertion that matters: nothing was orphaned and nothing was deleted.
    expect(db.getDomainByName("phoenix")).not.toBeNull();
    expect(db.countDomainDependents(domain.id)).toEqual([{ table: "mail", rows: 2 }]);
  });

  test("rm --force cascades: the domain AND its dependent rows are gone", async () => {
    const { db, handlers } = setup();
    const domain = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx)) as Domain;
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [domain.id]);

    const forced = (await invoke(handlers, "domainRemove")(
      { name: "phoenix", cascade: true },
      ctx,
    )) as DomainRemoveResult;
    expect(forced.removed).toBe(true);
    expect(forced.dependents).toEqual([{ table: "mail", rows: 1 }]);
    expect(db.getDomainByName("phoenix")).toBeNull();
    expect(db.countDomainDependents(domain.id)).toEqual([]);
  });

  test("rm of a domain with no dependents succeeds without --force", async () => {
    const { db, handlers } = setup();
    await invoke(handlers, "domainAdd")({ name: "solo", path: "/srv/solo" }, ctx);
    const result = (await invoke(handlers, "domainRemove")({ name: "solo" }, ctx)) as DomainRemoveResult;
    expect(result).toEqual({ found: true, removed: true, dependents: [] });
    expect(db.getDomainByName("solo")).toBeNull();
  });

  test("rm of an unknown domain reports not-found rather than a bare false", async () => {
    const { handlers } = setup();
    const result = (await invoke(handlers, "domainRemove")({ name: "ghost" }, ctx)) as DomainRemoveResult;
    expect(result).toEqual({ found: false, removed: false, dependents: [] });
  });

  test("round-trip: add → ls → show → which → rename → which → rm", async () => {
    const { handlers, dir } = setup();
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: dir }, ctx);

    expect(((await invoke(handlers, "domainList")(undefined, ctx)) as Domain[]).map((d) => d.name)).toEqual([
      "phoenix",
    ]);
    expect(((await invoke(handlers, "domainShow")({ name: "phoenix" }, ctx)) as Domain).path).toBe(dir);

    const before = (await invoke(handlers, "domainWhich")({ path: join(dir, "sub") }, ctx)) as DomainWhichResult;
    expect(before.domain?.name).toBe("phoenix");

    await invoke(handlers, "domainRename")({ from: "phoenix", to: "phoenix2" }, ctx);
    const after = (await invoke(handlers, "domainWhich")({ path: join(dir, "sub") }, ctx)) as DomainWhichResult;
    expect(after.domain?.name).toBe("phoenix2");

    expect(((await invoke(handlers, "domainRemove")({ name: "phoenix2" }, ctx)) as DomainRemoveResult).removed).toBe(
      true,
    );
    expect(await invoke(handlers, "domainList")(undefined, ctx)).toEqual([]);
  });

  test("show returns null for an unknown domain instead of throwing", async () => {
    const { handlers } = setup();
    expect(await invoke(handlers, "domainShow")({ name: "ghost" }, ctx)).toBeNull();
  });

  test("import WITHOUT --force refuses to arm and never touches the marker", async () => {
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { cleared: true };
      },
      () => "RECOVERY-TEXT",
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")(undefined, ctx)) as DomainImportResult;
    expect(result.armed).toBe(false);
    expect(clearCalls).toBe(0);
    expect(result.reason).toContain("--force");
    // The CLI never hardcodes either of these — they come from the daemon so the message
    // and the code path cannot drift.
    expect(result.markerKey).toBe(IMPORT_MARKER_KEY);
    expect(result.recovery).toBe("RECOVERY-TEXT");
  });

  test("--force arms even when the database holds rows — the guard is at the import, not here", async () => {
    // Deliberate, and driven rather than reasoned: `mcx domain import` is an IPC command,
    // so a daemon is running whenever it can be issued, and the daemon writes
    // `daemon.restarted` into `monitor_events` before accepting its first request. An
    // arm-time emptiness check would therefore refuse the correct recovery path every
    // single time — including immediately after `rm mcx.db`. The one enforcement point is
    // `importLegacyState` at boot, ahead of the first write; `import-legacy.spec.ts` drives
    // that. Arming against a populated database is harmless: the marker stays clear, the
    // next start refuses to copy, and the import runs once mcx.db is out of the way.
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    new WorkItemDb(db.database);
    new EventLog(db.database);
    migrateDerivedCursor(db.database);
    new EventLog(db.database).append({
      ts: new Date().toISOString(),
      src: "daemon",
      event: "daemon.restarted",
      category: "server",
    } as never);
    expect(nonEmptyImportedTables(db.database).map((t) => t.table)).toContain("monitor_events");

    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { cleared: true };
      },
      () => "RECOVERY-TEXT",
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")({ force: true }, ctx)) as DomainImportResult;
    expect(result.armed).toBe(true);
    expect(clearCalls).toBe(1);
    // The sequence the operator must follow reaches them either way.
    expect(result.recovery).toBe("RECOVERY-TEXT");
  });

  test("--force against an empty target clears the marker and reports armed", async () => {
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { cleared: true };
      },
      () => "RECOVERY-TEXT",
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")({ force: true }, ctx)) as DomainImportResult;
    expect(result.armed).toBe(true);
    expect(clearCalls).toBe(1);
  });

  test("the real guard sees monitor_events — the table its predecessor omitted", async () => {
    // Drives the production `nonEmptyImportedTables` (no injection) against a database
    // whose ONLY occupied table is monitor_events. `targetLooksEmpty()` reported EMPTY
    // here, which is what made the prescribed guard useless.
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    new WorkItemDb(db.database);
    new EventLog(db.database);
    migrateDerivedCursor(db.database);
    expect(nonEmptyImportedTables(db.database)).toEqual([]);

    // Exactly what the daemon writes before it accepts its first request (index.ts:718).
    new EventLog(db.database).append({
      ts: new Date().toISOString(),
      src: "daemon",
      event: "daemon.restarted",
      category: "server",
    } as never);
    const occupied = nonEmptyImportedTables(db.database);
    expect(occupied.map((t) => t.table)).toContain("monitor_events");
  });
});

describe("DomainHandlers — rm concurrency (#3160 review finding 6)", () => {
  const dirs2: string[] = [];
  const open2: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const o of open2) o.close();
    open2.length = 0;
    for (const d of dirs2) rmSync(d, { recursive: true, force: true });
    dirs2.length = 0;
  });

  function setup2(): { db: StateDb; handlers: Map<IpcMethod, RequestHandler> } {
    const dir = mkdtempSync(join(tmpdir(), "mcx-domain-race-"));
    dirs2.push(dir);
    const db = new StateDb(join(dir, "mcx.db"));
    open2.push(db);
    new WorkItemDb(db.database);
    new EventLog(db.database);
    migrateDerivedCursor(db.database);
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(db).register(handlers);
    return { db, handlers };
  }

  const ctx2 = {} as never;

  // NOTE on what is and is not tested here. The TOCTOU fix is *structural*: the handler no
  // longer counts dependents and re-decides, so it cannot disagree with `deleteDomain`,
  // which counts and refuses inside one call. There is no longer a window to inject into,
  // which is the point — so there is no test that fails on the old code and passes on the
  // new one, and pretending otherwise would be the green-test-over-an-unreachable-path
  // shape this review already caught once. What is testable is the contract that results
  // from it, below, plus the CLI's rendering of the race (`domain.spec.ts`).
  test("a dependent present at delete time yields a structured refusal and the domain survives", async () => {
    const { db, handlers } = setup2();
    const domain = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx2)) as Domain;
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [domain.id]);

    const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
    // The refusal reaches the caller as a *result* — never as the raw Error `deleteDomain`
    // throws, which is what the old handler surfaced whenever its own count disagreed.
    expect(result).toEqual({ found: true, removed: false, dependents: [{ table: "mail", rows: 1 }] });
    expect(db.getDomainByName("phoenix")).not.toBeNull();
    expect(db.countDomainDependents(domain.id)).toEqual([{ table: "mail", rows: 1 }]);
  });

  test("a domain deleted concurrently reports removed:false with NO dependents", async () => {
    const { db, handlers } = setup2();
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: "/srv/phoenix" }, ctx2);
    db.database.run("DELETE FROM domains WHERE name = ?", ["phoenix"]);

    const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
    // The CLI renders this as a race, not as "0 dependent row(s) still reference it".
    expect(result.removed).toBe(false);
    expect(result.dependents).toEqual([]);
  });

  test("the duplicate-location pre-check uses the SAME stored form as createDomain", async () => {
    // The pre-check derives the stored path itself (canonicalize for a local domain). If
    // state.ts ever changes that rule, the check would compare the wrong form, miss the
    // conflict, and fall through to the raw UNIQUE error it exists to prevent. A symlink
    // makes canonicalization load-bearing, so this test fails if the two rules diverge.
    const { handlers } = setup2();
    const real = mkdtempSync(join(tmpdir(), "mcx-dom-real-"));
    dirs2.push(real);
    const link = join(tmpdir(), `mcx-dom-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, link);
    try {
      await invoke(handlers, "domainAdd")({ name: "byreal", path: real }, ctx2);
      await expect(invoke(handlers, "domainAdd")({ name: "bylink", path: link }, ctx2)).rejects.toThrow(
        /already domain "byreal"/,
      );
    } finally {
      unlinkSync(link);
    }
  });
});
