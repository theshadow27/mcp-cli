import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";

/**
 * A **canonical** temp root. `tmpdir()` is `/var/folders/...` on macOS and `/var` is a
 * symlink, so the raw value is not what the code under test stores: domain paths go
 * through `canonicalizeExistingDomainPath`, so a fixture built on the unresolved spelling
 * asserts against a path production never writes. Resolving once here keeps the only
 * symlink in a fixture the one a test creates on purpose.
 */
const tmpdir = (): string => realpathSync(osTmpdir());
import { join } from "node:path";
import {
  type Domain,
  type DomainImportResult,
  type DomainRemoveResult,
  type DomainWhichResult,
  type IpcMethod,
  NO_DOMAIN_ID,
} from "@mcp-cli/core";
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

/**
 * A real directory inside a test's workspace, standing in for the `/srv/...` literals
 * these tests used before `domainAdd` began refusing a local path that does not exist
 * (#3210). The shape of that tree is what several of them are about — nesting, and the
 * longest-prefix rule that needs it — so it is reproduced rather than flattened.
 */
function srv(dir: string, ...segments: string[]): string {
  const path = join(dir, "srv", ...segments);
  mkdirSync(path, { recursive: true });
  return path;
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
    const { handlers, dir } = setup();
    const localPath = srv(dir, "local");
    const local = (await invoke(handlers, "domainAdd")({ name: "local", path: localPath }, ctx)) as Domain;
    const remote = (await invoke(handlers, "domainAdd")(
      { name: "remote", host: "boxen0010", path: "~/github/phoenix" },
      ctx,
    )) as Domain;

    expect(local.host).toBeNull();
    expect(local.path).toBe(localPath);
    expect(remote.host).toBe("boxen0010");
    // Verbatim: `~` there is that host's home, and this filesystem has no say.
    expect(remote.path).toBe("~/github/phoenix");
  });

  test("add rejects a relative local path at the protocol boundary", async () => {
    const { handlers } = setup();
    await expect(invoke(handlers, "domainAdd")({ name: "rel", path: "relative/path" }, ctx)).rejects.toThrow();
    await expect(invoke(handlers, "domainAdd")({ name: "tilde", path: "~/work" }, ctx)).rejects.toThrow();
  });

  test("add refuses a local path that does not exist yet (#3210)", async () => {
    const { handlers, dir } = setup();
    await expect(
      invoke(handlers, "domainAdd")({ name: "ghost", path: join(dir, "not", "created", "yet") }, ctx),
    ).rejects.toThrow(/does not exist/);
    expect((await invoke(handlers, "domainList")(undefined, ctx)) as Domain[]).toEqual([]);
  });

  test("...which is the untested direction of the canonicalization drift (#3210)", async () => {
    // Registering before the path exists stored the un-resolved spelling, because
    // `resolveRealpath` degrades to a lexical join. Let the path then appear under a
    // symlink — which is what `.claude/worktrees/` is — and `domainWhich` canonicalizes
    // the query against a filesystem that has moved, so it reports "not inside any
    // registered domain" for a domain `domainList` shows sitting right there.
    const { handlers, dir } = setup();
    const real = join(dir, "real");
    const link = join(dir, "link");
    const viaLink = join(link, "sub");

    await expect(invoke(handlers, "domainAdd")({ name: "phoenix", path: viaLink }, ctx)).rejects.toThrow(
      /does not exist/,
    );

    // Once the path exists, the same registration is accepted — and what it stores is the
    // resolved form, so the two commands cannot disagree afterwards.
    mkdirSync(join(real, "sub"), { recursive: true });
    symlinkSync(real, link);
    const added = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: viaLink }, ctx)) as Domain;
    expect(added.path).toBe(join(real, "sub"));

    for (const query of [viaLink, join(real, "sub"), join(viaLink, "deeper")]) {
      const hit = (await invoke(handlers, "domainWhich")({ path: query }, ctx)) as DomainWhichResult;
      expect(hit.domain?.name).toBe("phoenix");
    }
  });

  test("a host-bound path is exempt from the existence rule — it is not on this filesystem", async () => {
    const { handlers } = setup();
    const remote = (await invoke(handlers, "domainAdd")(
      { name: "remote", host: "boxen0010", path: "/srv/definitely/not/here" },
      ctx,
    )) as Domain;
    expect(remote.path).toBe("/srv/definitely/not/here");
  });

  test("add rejects a duplicate name and names where the existing one lives", async () => {
    const { handlers, dir } = setup();
    const phoenix = srv(dir, "phoenix");
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: phoenix }, ctx);
    await expect(invoke(handlers, "domainAdd")({ name: "phoenix", path: srv(dir, "other") }, ctx)).rejects.toThrow(
      `already exists at ${phoenix}`,
    );
  });

  test("add rejects a location already owned, naming the owner", async () => {
    const { handlers, dir } = setup();
    const phoenix = srv(dir, "phoenix");
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: phoenix }, ctx);
    await expect(invoke(handlers, "domainAdd")({ name: "second", path: phoenix }, ctx)).rejects.toThrow(
      /already domain "phoenix"/,
    );
  });

  test("NESTING IS LEGAL: add refuses only an exact location, never a containing one", async () => {
    // #3039's filtering semantics depend on this being registrable — its doc section uses
    // `~/github` plus `~/github/mcp-cli` as the worked example, and the longest-prefix rule
    // in `resolveDomainForPath` has nothing to decide if the inner domain cannot exist.
    // The refusal is equality on `(host, path)`, not the prefix relation that the word
    // "owns" means everywhere else in docs/domains.md.
    const { handlers, dir } = setup();
    const mcpCli = srv(dir, "github", "mcp-cli");
    await invoke(handlers, "domainAdd")({ name: "outer", path: srv(dir, "github") }, ctx);
    const inner = (await invoke(handlers, "domainAdd")({ name: "inner", path: mcpCli }, ctx)) as Domain;
    expect(inner.name).toBe("inner");

    // A parent of an existing domain is equally fine.
    const above = (await invoke(handlers, "domainAdd")({ name: "above", path: srv(dir) }, ctx)) as Domain;
    expect(above.name).toBe("above");

    // Only the exact location is refused.
    await expect(invoke(handlers, "domainAdd")({ name: "dup", path: mcpCli }, ctx)).rejects.toThrow(
      /already domain "inner"/,
    );

    // ...and resolution still picks the innermost, which is the point of allowing nesting.
    const hit = (await invoke(handlers, "domainWhich")({ path: join(mcpCli, "src") }, ctx)) as DomainWhichResult;
    expect(hit.domain?.name).toBe("inner");
  });

  test("a host-bound path does not collide with the same local path", async () => {
    const { handlers, dir } = setup();
    const app = srv(dir, "app");
    await invoke(handlers, "domainAdd")({ name: "here", path: app }, ctx);
    const there = (await invoke(handlers, "domainAdd")({ name: "there", host: "boxen0010", path: app }, ctx)) as Domain;
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
    const { db, handlers, dir } = setup();
    const before = (await invoke(handlers, "domainAdd")({ name: "old", path: srv(dir, "app") }, ctx)) as Domain;
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
    const { handlers, dir } = setup();
    await invoke(handlers, "domainAdd")({ name: "a", path: srv(dir, "a") }, ctx);
    await invoke(handlers, "domainAdd")({ name: "b", path: srv(dir, "b") }, ctx);
    await expect(invoke(handlers, "domainRename")({ from: "nope", to: "c" }, ctx)).rejects.toThrow(/no domain named/);
    await expect(invoke(handlers, "domainRename")({ from: "a", to: "b" }, ctx)).rejects.toThrow(/already exists/);
  });

  test("rm REFUSES while dependents exist — and leaves every row where it was", async () => {
    const { db, handlers, dir } = setup();
    const domain = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx)) as Domain;
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
    const { db, handlers, dir } = setup();
    const domain = (await invoke(handlers, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx)) as Domain;
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
    const { db, handlers, dir } = setup();
    await invoke(handlers, "domainAdd")({ name: "solo", path: srv(dir, "solo") }, ctx);
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

  test("no legacy database: says so, does not claim a marker is set", async () => {
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { state: "armed" as const, alreadyArmed: false };
      },
      () => "RECOVERY-TEXT",
      () => ({ present: false, value: null }),
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")(undefined, ctx)) as DomainImportResult;
    expect(result.armed).toBe(false);
    expect(clearCalls).toBe(0);
    expect(result.reason).toContain("no legacy database");
    // The field the CLI gates the `rm` incantation on — absent, so it is not printed.
    expect(result.markerSetAt).toBeUndefined();
  });

  test("marker set: names when, and points at --force", async () => {
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { state: "armed" as const, alreadyArmed: false };
      },
      () => "RECOVERY-TEXT",
      () => ({ present: true, value: "2026-08-20T10:00:00.000Z" }),
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")(undefined, ctx)) as DomainImportResult;
    expect(result.armed).toBe(false);
    expect(clearCalls).toBe(0);
    expect(result.markerSetAt).toBe("2026-08-20T10:00:00.000Z");
    expect(result.reason).toContain("--force");
    expect(result.markerKey).toBe(IMPORT_MARKER_KEY);
  });

  test("marker already clear: reports ARMED, not failure (#3160 N13)", async () => {
    // Without --force, and the marker is already gone — which seal-or-nothing guarantees
    // after any failed import. The old code reported this as a refusal.
    const dir = workspace();
    const db = new StateDb(join(dir, "mcx.db"));
    open.push(db);
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => ({ state: "armed" as const, alreadyArmed: true }),
      () => "RECOVERY-TEXT",
      () => ({ present: true, value: null }),
    ).register(handlers);

    const result = (await invoke(handlers, "domainImport")(undefined, ctx)) as DomainImportResult;
    expect(result.armed).toBe(true);
    expect(result.alreadyArmed).toBe(true);
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
      domainId: NO_DOMAIN_ID,
    } as never);
    expect(nonEmptyImportedTables(db.database).map((t) => t.table)).toContain("monitor_events");

    let clearCalls = 0;
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(
      db,
      () => {
        clearCalls++;
        return { state: "armed" as const, alreadyArmed: false };
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
        return { state: "armed" as const, alreadyArmed: false };
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
      domainId: NO_DOMAIN_ID,
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

  function setup2(): { db: StateDb; handlers: Map<IpcMethod, RequestHandler>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "mcx-domain-race-"));
    dirs2.push(dir);
    const db = new StateDb(join(dir, "mcx.db"));
    open2.push(db);
    new WorkItemDb(db.database);
    new EventLog(db.database);
    migrateDerivedCursor(db.database);
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(db).register(handlers);
    return { db, handlers, dir };
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
    const { db, handlers, dir } = setup2();
    const domain = (await invoke(handlers, "domainAdd")(
      { name: "phoenix", path: srv(dir, "phoenix") },
      ctx2,
    )) as Domain;
    db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [domain.id]);

    const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
    // The refusal reaches the caller as a *result* — never as the raw Error `deleteDomain`
    // throws, which is what the old handler surfaced whenever its own count disagreed.
    expect(result).toEqual({ found: true, removed: false, dependents: [{ table: "mail", rows: 1 }] });
    expect(db.getDomainByName("phoenix")).not.toBeNull();
    expect(db.countDomainDependents(domain.id)).toEqual([{ table: "mail", rows: 1 }]);
  });

  test("a row deleted BEFORE the lookup is not-found, not a race (#3160 N15)", async () => {
    // This test used to claim it covered the concurrent-delete race. It does not: deleting
    // before the handler runs makes `getDomainByName` return null, so it takes the
    // NOT-FOUND return — the same path as "rm of an unknown domain". It asserted `removed`
    // and `dependents` but never `found`, which is the one field that distinguishes the two.
    // Asserting `found` is what makes the test name match the path it exercises.
    const { db, handlers, dir } = setup2();
    await invoke(handlers, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx2);
    db.database.run("DELETE FROM domains WHERE name = ?", ["phoenix"]);

    const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
    expect(result.found).toBe(false);
    expect(result.removed).toBe(false);
    expect(result.dependents).toEqual([]);
  });

  test("the GENUINE race — found, then vanished before the delete — reports found:true", async () => {
    // `{found: true, removed: false, dependents: []}` had no handler coverage at all; it
    // existed only as a hand-built literal in the CLI harness. Driven here by deleting the
    // row between the handler's lookup and its delete, via an injected StateDb whose
    // `deleteDomain` removes the row itself and reports that it changed nothing.
    const { db, handlers: _unused, dir } = setup2();
    await invoke(_unused, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx2);

    const racing = Object.create(db) as typeof db;
    Object.defineProperty(racing, "deleteDomain", {
      value: (name: string) => {
        db.database.run("DELETE FROM domains WHERE name = ?", [name]);
        return false; // another actor got there first
      },
    });
    const handlers = new Map<IpcMethod, RequestHandler>();
    new DomainHandlers(racing).register(handlers);

    const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
    expect(result).toEqual({ found: true, removed: false, dependents: [] });
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

  /**
   * #3180. The catch used to re-count dependents on ANY throw and return the refusal
   * shape whenever the count came back non-empty. The count is non-empty after every
   * failed delete — the transaction rolled back — so a disk-full, a corruption, or the
   * `SQLITE_BUSY_SNAPSHOT` the DEFERRED transaction used to produce all reached the
   * operator as "re-run with --force", advice they had already taken, with the real
   * error discarded.
   */
  describe("only a refusal becomes a result (#3180)", () => {
    function withFailingDelete(db: StateDb, err: Error): Map<IpcMethod, RequestHandler> {
      const failing = Object.create(db) as StateDb;
      Object.defineProperty(failing, "deleteDomain", {
        value: () => {
          throw err;
        },
      });
      const handlers = new Map<IpcMethod, RequestHandler>();
      new DomainHandlers(failing).register(handlers);
      return handlers;
    }

    test("a real failure during --force propagates instead of becoming a --force refusal", async () => {
      const { db, handlers: setup, dir } = setup2();
      const domain = (await invoke(setup, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx2)) as Domain;
      db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [
        domain.id,
      ]);

      const failure = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      const handlers = withFailingDelete(db, failure);

      await expect(invoke(handlers, "domainRemove")({ name: "phoenix", cascade: true }, ctx2)).rejects.toThrow(
        "database or disk is full",
      );
      expect(db.getDomainByName("phoenix")).not.toBeNull();
    });

    test("...and the same is true without --force, where dependents also block", async () => {
      // The non-cascade path is where the laundering was most convincing: dependents
      // really do exist, so the re-count "confirmed" a refusal that never happened.
      const { db, handlers: setup, dir } = setup2();
      const domain = (await invoke(setup, "domainAdd")({ name: "phoenix", path: srv(dir, "phoenix") }, ctx2)) as Domain;
      db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [
        domain.id,
      ]);

      const handlers = withFailingDelete(db, Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
      await expect(invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)).rejects.toThrow("database is locked");
    });

    test("the genuine refusal still comes back as a structured result, not a throw", async () => {
      // The other half of the branch: real `deleteDomain`, real dependents. This is what
      // makes the rethrow above a narrowing rather than a removal of the refusal path.
      const { db, handlers, dir } = setup2();
      const domain = (await invoke(handlers, "domainAdd")(
        { name: "phoenix", path: srv(dir, "phoenix") },
        ctx2,
      )) as Domain;
      db.database.run("INSERT INTO mail (domain_id, sender, recipient, subject) VALUES (?, 'a', 'b', 'hi')", [
        domain.id,
      ]);

      const result = (await invoke(handlers, "domainRemove")({ name: "phoenix" }, ctx2)) as DomainRemoveResult;
      expect(result).toEqual({ found: true, removed: false, dependents: [{ table: "mail", rows: 1 }] });
    });
  });
});
