import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDerivedCursor } from "../derived-events";
import { EventLog } from "../event-log";
import { IMPORTED_TABLES, IMPORT_MARKER_KEY, importLegacyState, recoveryInstructions } from "./import-legacy";
import { StateDb } from "./state";
import { WorkItemDb } from "./work-items";

/**
 * A stand-in for the pre-domain `state.db`: the subset of the old schema the import
 * actually reads, written by hand so the test does not depend on the current DDL.
 */
function writeLegacyDb(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO schema_versions (name, version) VALUES ('state', 7), ('work_items', 7);

    CREATE TABLE daemon_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO daemon_state (key, value) VALUES ('config_hash', 'abc123');

    CREATE TABLE auth_tokens (
      server_name TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT,
      token_type TEXT DEFAULT 'Bearer', expires_at INTEGER, scope TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO auth_tokens (server_name, access_token) VALUES ('atlassian', 'tok');

    CREATE TABLE mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      subject TEXT, body TEXT, reply_to INTEGER, read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
    );
    INSERT INTO mail (sender, recipient, subject) VALUES ('a', 'b', 'hi'), ('c', 'd', 'yo');

    CREATE TABLE alias_state (
      repo_root TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL,
      value_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo_root, namespace, key)
    );
    INSERT INTO alias_state (repo_root, namespace, key, value_json) VALUES ('/repo', 'ns', 'k', '"v"');

    CREATE TABLE work_items (
      id TEXT PRIMARY KEY, issue_number INTEGER UNIQUE, branch TEXT UNIQUE, pr_number INTEGER UNIQUE,
      pr_state TEXT DEFAULT 'open', pr_url TEXT, ci_status TEXT DEFAULT 'none', ci_run_id INTEGER,
      ci_summary TEXT, review_status TEXT DEFAULT 'none', phase TEXT DEFAULT 'impl',
      created_at TEXT, updated_at TEXT, last_seen_head_oid TEXT, merge_state_status TEXT,
      version INTEGER NOT NULL DEFAULT 1, automation_overrides TEXT
    );
    INSERT INTO work_items (id, issue_number, branch, phase) VALUES ('wi-1', 42, 'fix/issue-42', 'impl');

    -- A column the new schema does not have: it must be dropped, not fail the table.
    CREATE TABLE notes (
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL, note TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, retired_column TEXT,
      PRIMARY KEY (server_name, tool_name)
    );
    INSERT INTO notes (server_name, tool_name, note, retired_column) VALUES ('s', 't', 'n', 'gone');

    -- Excluded from the import on purpose (volatile / rebuildable).
    CREATE TABLE tool_cache (server_name TEXT NOT NULL, tool_name TEXT NOT NULL, PRIMARY KEY (server_name, tool_name));
    INSERT INTO tool_cache (server_name, tool_name) VALUES ('s', 't');
  `);
  db.close();
}

function freshTargetDb(path: string): StateDb {
  const state = new StateDb(path);
  new WorkItemDb(state.database);
  new EventLog(state.database);
  migrateDerivedCursor(state.database);
  return state;
}

describe("importLegacyState", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace(): { dir: string; legacyPath: string; targetPath: string; scopesDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-"));
    dirs.push(dir);
    return {
      dir,
      legacyPath: join(dir, "state.db"),
      targetPath: join(dir, "mcx.db"),
      scopesDir: join(dir, "scopes"),
    };
  }

  function target(path: string): StateDb {
    const state = freshTargetDb(path);
    open.push(state);
    return state;
  }

  test("declines when there is no legacy database", () => {
    const ws = workspace();
    const state = target(ws.targetPath);
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("no legacy database");
  });

  test("copies rows that map, drops retired columns, and skips excluded tables", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);

    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });

    expect(result.ran).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);

    const raw = state.database;
    expect(state.getState("config_hash")).toBe("abc123");
    expect(state.getTokens("atlassian")?.access_token).toBe("tok");
    expect(raw.query<{ n: number }, []>("SELECT count(*) AS n FROM mail").get()?.n).toBe(2);
    expect(state.getAliasState("/repo", "ns", "k")).toBe("v");
    expect(state.getNote("s", "t")).toBe("n");

    const wi = new WorkItemDb(raw);
    expect(wi.getWorkItemByIssue(42)?.branch).toBe("fix/issue-42");

    // tool_cache is deliberately not imported.
    expect(raw.query<{ n: number }, []>("SELECT count(*) AS n FROM tool_cache").get()?.n).toBe(0);
  });

  test("never copies schema_versions — that would make every consumer skip its migrations", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    const before = state.database
      .query<{ name: string; version: number }, []>("SELECT name, version FROM schema_versions ORDER BY name")
      .all();

    importLegacyState({ db: state.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });

    const after = state.database
      .query<{ name: string; version: number }, []>("SELECT name, version FROM schema_versions ORDER BY name")
      .all();
    expect(after).toEqual(before);
  });

  test("imports scope sidecars as local domains and reports the ones it skips", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    mkdirSync(ws.scopesDir, { recursive: true });
    writeFileSync(
      join(ws.scopesDir, "phoenix.json"),
      JSON.stringify({ root: "/home/u/github/phoenix/", created: "2026-01-02T03:04:05.000Z" }),
    );
    writeFileSync(join(ws.scopesDir, "mcp-cli.json"), JSON.stringify({ root: "/home/u/github/mcp-cli" }));
    writeFileSync(join(ws.scopesDir, "broken.json"), "{not json");
    writeFileSync(join(ws.scopesDir, "rootless.json"), JSON.stringify({ created: "x" }));

    const state = target(ws.targetPath);
    const logs: string[] = [];
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });

    expect(result.domainsImported).toBe(2);
    expect(result.domainsSkipped).toBe(2);

    const domains = state.listDomains();
    expect(domains.map((d) => d.name)).toEqual(["mcp-cli", "phoenix"]);
    expect(domains.every((d) => d.host === null)).toBe(true);
    const phoenix = state.getDomainByName("phoenix");
    expect(phoenix?.path).toBe("/home/u/github/phoenix");
    expect(phoenix?.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(logs.some((l) => l.includes("broken"))).toBe(true);
    expect(logs.some((l) => l.includes("rootless"))).toBe(true);
  });

  test("writes the marker into the LEGACY database, not into mcx.db", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);

    importLegacyState({ db: state.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });

    // Deleting mcx.db must not re-arm the import, so the marker cannot live there.
    expect(state.getState(IMPORT_MARKER_KEY)).toBeNull();

    const legacy = new Database(ws.legacyPath, { readwrite: true, create: false });
    const marker = legacy
      .query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?")
      .get(IMPORT_MARKER_KEY);
    legacy.close();
    expect(marker?.value).toBeTruthy();
  });

  test("is idempotent: a second daemon start declines", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const first = target(ws.targetPath);
    const a = importLegacyState({
      db: first.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(a.ran).toBe(true);

    const b = importLegacyState({
      db: first.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(b.ran).toBe(false);
    expect(b.reason).toContain("already imported");
    // Nothing was duplicated.
    expect(first.database.query<{ n: number }, []>("SELECT count(*) AS n FROM mail").get()?.n).toBe(2);
  });

  test("the marker survives deleting mcx.db — a rebuilt DB does not re-import", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const first = target(ws.targetPath);
    importLegacyState({ db: first.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });
    first.close();
    open.pop();
    rmSync(ws.targetPath, { force: true });

    const rebuilt = target(ws.targetPath);
    const result = importLegacyState({
      db: rebuilt.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("already imported");
  });

  test("--force re-runs and does not duplicate or clobber", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    importLegacyState({ db: state.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });

    // Post-import work that a re-run must not overwrite.
    state.setState("config_hash", "local-change");

    const forced = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      force: true,
      log: () => {},
    });
    expect(forced.ran).toBe(true);
    expect(forced.sealed).toBe(true);
    expect(forced.totalCopied).toBe(0);
    expect(forced.totalNotCopied).toBeGreaterThan(0);
    expect(forced.failedTables).toEqual([]);
    expect(state.getState("config_hash")).toBe("local-change");
    expect(state.database.query<{ n: number }, []>("SELECT count(*) AS n FROM mail").get()?.n).toBe(2);
  });

  test("imported rows land in the unassigned partition, not in a guessed domain", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    mkdirSync(ws.scopesDir, { recursive: true });
    writeFileSync(join(ws.scopesDir, "phoenix.json"), JSON.stringify({ root: "/home/u/github/phoenix" }));
    const state = target(ws.targetPath);

    importLegacyState({ db: state.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });

    const rows = state.database
      .query<{ domain_id: number }, []>("SELECT domain_id FROM work_items UNION SELECT domain_id FROM mail")
      .all();
    expect(rows.every((r) => r.domain_id === 0)).toBe(true);
  });

  test("a corrupt legacy database is declined, not thrown", () => {
    const ws = workspace();
    writeFileSync(ws.legacyPath, "this is not a sqlite database");
    const state = target(ws.targetPath);
    const logs: string[] = [];
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });
    expect(result.ran).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("importLegacyState — marker sealing contract (#3034 review B2/B3/B4)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) {
      try {
        chmodSync(join(d, "state.db"), 0o644);
        // dotw-ignore test-empty-catch: best-effort — the file may not exist in every case
      } catch {
        /* ignore */
      }
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-seal-"));
    dirs.push(dir);
    return { dir, legacyPath: join(dir, "state.db"), targetPath: join(dir, "mcx.db"), scopesDir: join(dir, "scopes") };
  }

  function target(path: string): StateDb {
    const state = freshTargetDb(path);
    open.push(state);
    return state;
  }

  function markerOf(legacyPath: string): string | null {
    const legacy = new Database(legacyPath, { readwrite: true, create: false });
    const row = legacy
      .query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?")
      .get(IMPORT_MARKER_KEY);
    legacy.close();
    return row?.value ?? null;
  }

  test("B2: a wholly failed import does NOT write the marker and reports the failures", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    // A bare mcx.db: none of the consumer tables exist, so every copy target is missing.
    const bare = new Database(ws.targetPath, { create: true });
    bare.exec("CREATE TABLE schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    bare.exec(
      "CREATE TABLE domains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, host TEXT, path TEXT NOT NULL, created_at TEXT NOT NULL)",
    );

    const logs: string[] = [];
    const result = importLegacyState({
      db: bare,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });
    bare.close();

    expect(result.ran).toBe(true);
    expect(result.sealed).toBe(false);
    expect(result.failedTables.length).toBeGreaterThan(0);
    expect(result.totalCopied).toBe(0);
    // The marker must NOT be sealed over a failed import.
    expect(markerOf(ws.legacyPath)).toBeNull();
    expect(logs.some((l) => l.includes("ROLLED BACK — nothing was imported."))).toBe(true);
  });

  test("B2: a failed import retries on the next start instead of being sealed forever", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const bare = new Database(ws.targetPath, { create: true });
    bare.exec("CREATE TABLE schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    bare.exec(
      "CREATE TABLE domains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, host TEXT, path TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    importLegacyState({ db: bare, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });
    bare.close();
    rmSync(ws.targetPath, { force: true });

    // Second start, this time with a properly migrated target: the import must still run.
    const good = target(ws.targetPath);
    const retry = importLegacyState({
      db: good.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(retry.ran).toBe(true);
    expect(retry.sealed).toBe(true);
    expect(retry.totalCopied).toBeGreaterThan(0);
    expect(markerOf(ws.legacyPath)).toBeTruthy();
  });

  test("B3: marker set + empty mcx.db warns loudly and prints the real recovery command", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const first = target(ws.targetPath);
    importLegacyState({ db: first.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });
    first.close();
    open.pop();
    rmSync(ws.targetPath, { force: true });

    const rebuilt = target(ws.targetPath);
    const logs: string[] = [];
    const result = importLegacyState({
      db: rebuilt.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });

    expect(result.ran).toBe(false);
    const warning = logs.find((l) => l.includes("WARNING"));
    expect(warning).toBeTruthy();
    expect(warning).toContain("WITHOUT your imported data");
    // The message must carry the incantation that actually works, not "delete mcx.db".
    expect(warning).toContain(recoveryInstructions(ws.legacyPath, ws.targetPath));
    expect(warning).toContain(IMPORT_MARKER_KEY);
  });

  test("B3: the documented recovery command actually re-arms the import", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const first = target(ws.targetPath);
    importLegacyState({ db: first.database, legacyPath: ws.legacyPath, scopesDir: ws.scopesDir, log: () => {} });
    first.close();
    open.pop();

    // Exactly what RECOVERY_INSTRUCTIONS tells the user to do.
    rmSync(ws.targetPath, { force: true });
    const legacy = new Database(ws.legacyPath, { readwrite: true, create: false });
    legacy.run("DELETE FROM daemon_state WHERE key = ?", [IMPORT_MARKER_KEY]);
    legacy.close();

    const rebuilt = target(ws.targetPath);
    const result = importLegacyState({
      db: rebuilt.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.ran).toBe(true);
    expect(result.sealed).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);
  });

  test("B4: an unwritable legacy DB copies NOTHING and says so accurately", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    chmodSync(ws.legacyPath, 0o444);

    const logs: string[] = [];
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("not writable");
    // No torn outcome: nothing was copied, so nothing can be resurrected on the re-run.
    const wi = state.database.query<{ n: number }, []>("SELECT count(*) AS n FROM work_items").get();
    expect(wi?.n).toBe(0);
    expect(logs.some((l) => l.includes("not writable"))).toBe(true);
    // And the old, false message is gone.
    expect(logs.some((l) => l.includes("legacy database left untouched"))).toBe(false);
  });

  test("12: imported monitor_events do not replay — the derived cursor is parked at the newest", () => {
    const ws = workspace();
    const legacy = new Database(ws.legacyPath, { create: true });
    legacy.exec(`
      CREATE TABLE daemon_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE monitor_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, src TEXT NOT NULL, event TEXT NOT NULL,
        category TEXT NOT NULL, work_item_id TEXT, session_id TEXT, pr_number INTEGER, payload TEXT NOT NULL
      );
    `);
    for (let i = 1; i <= 5; i++) {
      legacy.run(
        "INSERT INTO monitor_events (ts, src, event, category, payload) VALUES (?, 'test', 'e', 'server', '{}')",
        [`2026-01-0${i}T00:00:00.000Z`],
      );
    }
    legacy.close();

    const state = target(ws.targetPath);
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.ran).toBe(true);

    const events = state.database.query<{ n: number }, []>("SELECT count(*) AS n FROM monitor_events").get();
    expect(events?.n).toBe(5);
    const cursor = state.database
      .query<{ last_seq: number }, []>("SELECT last_seq FROM derived_cursor WHERE id = 'derived_publisher'")
      .get();
    expect(cursor?.last_seq).toBe(5);
  });

  test("13: a failed table is distinguishable from an empty one", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    const absent = result.tables.find((t) => t.table === "oauth_clients");
    expect(absent?.failed).toBe(false);
    expect(absent?.reason).toBe("absent from legacy database");
    expect(result.failedTables).toEqual([]);
  });
});

describe("importLegacyState — against the PRODUCTION schema (#3034 review coverage gap)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-prod-"));
    dirs.push(dir);
    return { dir, legacyPath: join(dir, "state.db"), targetPath: join(dir, "mcx.db"), scopesDir: join(dir, "scopes") };
  }

  test("every IMPORTED_TABLES entry exists in a freshly migrated mcx.db", () => {
    // The import reports a target table it cannot find as a hard FAILURE, which withholds
    // the marker. So an 18th entry added here without a matching migration would break
    // every install's import — and this is the test that says so, rather than a user
    // discovering it once, on the one run they get.
    const ws = workspace();
    const state = freshTargetDb(ws.targetPath);
    open.push(state);

    const missing = IMPORTED_TABLES.filter(
      (t) =>
        (state.database
          .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
          .get(t)?.n ?? 0) === 0,
    );
    expect(missing).toEqual([]);
  });

  test("imports a legacy DB built by the real StateDb/WorkItemDb/EventLog code", () => {
    // The other fixtures are hand-written and therefore cannot drift with the schema.
    // This one is produced by the production DDL on both sides, so a column added to a
    // real table is exercised here without anyone remembering to update a string literal.
    const ws = workspace();

    const legacy = freshTargetDb(ws.legacyPath);
    legacy.setState("config_hash", "prod-hash");
    legacy.saveTokens("atlassian", { access_token: "prod-tok", token_type: "Bearer" });
    legacy.setNote("srv", "tool", "a note");
    legacy.setAliasState("/repo", "ns", "k", { nested: [1, 2, 3] });
    legacy.insertMail("alice", "bob", "subject", "body");
    legacy.upsertSession({ sessionId: "sess-1", provider: "claude", cwd: "/repo", state: "running" });
    legacy.saveAlias("impl", "/repo/.claude/phases/impl.ts", "the impl phase", "defineAlias");
    const legacyWi = new WorkItemDb(legacy.database);
    legacyWi.createWorkItem({ issueNumber: 4242, branch: "feat/prod-fixture", prNumber: 99 });
    legacy.close();

    const target = freshTargetDb(ws.targetPath);
    open.push(target);
    const logs: string[] = [];
    const result = importLegacyState({
      db: target.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });

    expect(result.failedTables).toEqual([]);
    expect(result.ran).toBe(true);
    expect(result.sealed).toBe(true);

    // Every seeded row survived the real-schema round trip.
    expect(target.getState("config_hash")).toBe("prod-hash");
    expect(target.getTokens("atlassian")?.access_token).toBe("prod-tok");
    expect(target.getNote("srv", "tool")).toBe("a note");
    expect(target.getAliasState("/repo", "ns", "k")).toEqual({ nested: [1, 2, 3] });
    expect(target.getAlias("impl")?.description).toBe("the impl phase");
    expect(target.getSession("sess-1")?.cwd).toBe("/repo");
    expect(target.database.query<{ n: number }, []>("SELECT count(*) AS n FROM mail").get()?.n).toBe(1);
    expect(new WorkItemDb(target.database).getWorkItemByIssue(4242)?.branch).toBe("feat/prod-fixture");
  });

  test("a production-schema import is idempotent and copies nothing the second time", () => {
    const ws = workspace();
    const legacy = freshTargetDb(ws.legacyPath);
    legacy.setState("config_hash", "prod-hash");
    legacy.close();

    const target = freshTargetDb(ws.targetPath);
    open.push(target);
    const first = importLegacyState({
      db: target.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(first.sealed).toBe(true);

    const second = importLegacyState({
      db: target.database,
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      force: true,
      log: () => {},
    });
    expect(second.failedTables).toEqual([]);
    expect(second.totalCopied).toBe(0);
    expect(target.getState("config_hash")).toBe("prod-hash");
  });
});

describe("import atomicity — an unsealed run leaves the target untouched (#3034 review R1)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-atomic-"));
    dirs.push(dir);
    return { dir, legacyPath: join(dir, "state.db"), targetPath: join(dir, "mcx.db"), scopesDir: join(dir, "scopes") };
  }

  function target(path: string): StateDb {
    const state = freshTargetDb(path);
    open.push(state);
    return state;
  }

  /** Row counts for every table the import touches, so a run can be proved a no-op. */
  function snapshot(db: Database): Record<string, number> {
    // Ask the schema which tables exist rather than probing with try/catch — one of these
    // tests DROPs a table on purpose, and a swallowed error is indistinguishable from a
    // real one.
    const present = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    const out: Record<string, number> = {};
    for (const t of [...IMPORTED_TABLES, "domains"]) {
      if (!present.has(t)) continue;
      out[t] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t}"`).get()?.n ?? 0;
    }
    return out;
  }

  function markerOf(legacyPath: string): string | null {
    const legacy = new Database(legacyPath, { readwrite: true, create: false });
    const row = legacy
      .query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?")
      .get(IMPORT_MARKER_KEY);
    legacy.close();
    return row?.value ?? null;
  }

  test("(a) one failed table rolls back the other sixteen — nothing is committed", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    mkdirSync(ws.scopesDir, { recursive: true });
    writeFileSync(join(ws.scopesDir, "phoenix.json"), JSON.stringify({ root: "/home/u/github/phoenix" }));
    const state = target(ws.targetPath);
    // Remove one target table so exactly one copy fails.
    state.database.run("DROP TABLE notes");

    const before = snapshot(state.database);
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      targetPath: ws.targetPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });

    expect(result.sealed).toBe(false);
    expect(result.failedTables).toContain("notes");
    // The whole point: NOT "17 rows committed, marker withheld".
    expect(snapshot(state.database)).toEqual(before);
    expect(markerOf(ws.legacyPath)).toBeNull();
    // ...including the scope→domain rows, which used to sit outside the transaction.
    expect(state.listDomains()).toEqual([]);
  });

  test("(a2) an unsealed pass cannot resurrect rows the user deleted afterwards", () => {
    // The regression the reviewer asked for: unsealed pass → mutate the target → retry
    // → the target is unchanged. The old shape committed rows, withheld the marker, and
    // then re-imported (and resurrected) on every subsequent start, forever.
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    state.database.run("DROP TABLE notes");
    importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      targetPath: ws.targetPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });

    // A user doing ordinary work in the target between starts.
    state.setState("user_key", "user_value");
    const before = snapshot(state.database);

    const retry = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      targetPath: ws.targetPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(retry.sealed).toBe(false);
    expect(snapshot(state.database)).toEqual(before);
    expect(state.getState("user_key")).toBe("user_value");
  });

  test("(c) a transaction aborted by SQLite commits nothing and reports the real error", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    // Give the legacy DB a payload big enough that copying it MUST allocate new pages —
    // a handful of small rows fits in the target's existing free pages and never
    // overflows, which is why pinning max_page_count alone was not enough to trigger it.
    const seed = new Database(ws.legacyPath, { readwrite: true, create: false });
    seed.run("INSERT INTO notes (server_name, tool_name, note) VALUES ('big', 'blob', ?)", ["x".repeat(2_000_000)]);
    seed.close();

    const state = target(ws.targetPath);
    const before = snapshot(state.database);
    // Force SQLITE_FULL mid-copy: SQLite ABORTS the transaction, which used to let the
    // remaining copies run in autocommit and be permanently committed.
    const pages = state.database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 2;
    state.database.exec(`PRAGMA max_page_count = ${pages}`);

    const logs: string[] = [];
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      targetPath: ws.targetPath,
      scopesDir: ws.scopesDir,
      log: (m) => logs.push(m),
    });
    state.database.exec("PRAGMA max_page_count = 1073741823");

    expect(result.sealed).toBe(false);
    expect(snapshot(state.database)).toEqual(before);
    expect(markerOf(ws.legacyPath)).toBeNull();
    // The rollback's own error must not have replaced the real one.
    const joined = logs.join("\n");
    expect(joined).not.toContain("cannot rollback - no transaction is active");
    // D1.3: the caller must be able to tell a failure from an empty import. Returning
    // declined()'s zeros here reported "ran:false, totalCopied:0" for a run that had
    // actually copied and rolled back real rows.
    expect(result.tables.length).toBeGreaterThan(0);
    expect(result.reason).toBeTruthy();
    expect(joined).toMatch(/disk is full|database or disk|rolled back/i);
  });

  test("a successful import still commits everything and seals", () => {
    const ws = workspace();
    writeLegacyDb(ws.legacyPath);
    const state = target(ws.targetPath);
    const result = importLegacyState({
      db: state.database,
      legacyPath: ws.legacyPath,
      targetPath: ws.targetPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.sealed).toBe(true);
    expect(result.failedTables).toEqual([]);
    expect(result.totalCopied).toBeGreaterThan(0);
    expect(markerOf(ws.legacyPath)).toBeTruthy();
    expect(state.getState("config_hash")).toBe("abc123");
  });
});

describe("recoveryInstructions (#3034 review R2)", () => {
  test("names the databases this process actually opened, not ~/.mcp-cli", () => {
    const text = recoveryInstructions("/srv/custom/state.db", "/srv/custom/mcx.db");
    expect(text).toContain("/srv/custom/mcx.db");
    expect(text).toContain("/srv/custom/state.db");
    // The bug: diagnosing the real DB then instructing `rm` of a different, healthy one.
    expect(text).not.toContain("~/.mcp-cli");
  });

  test("backs up before deleting, since this arc has no rollback", () => {
    const text = recoveryInstructions("/srv/s.db", "/srv/m.db");
    expect(text).toContain("cp /srv/m.db /srv/m.db.bak");
    expect(text.indexOf("cp ")).toBeLessThan(text.indexOf("rm "));
  });

  test("clears both marker keys, so the re-armed import is not half-armed", () => {
    const text = recoveryInstructions("/srv/s.db", "/srv/m.db");
    expect(text).toContain(IMPORT_MARKER_KEY);
    expect(text).toContain("mcx_domain_import_rows");
  });
});

describe("legacy handle contention (#3034 review Y7)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("a held write lock is waited out, not reported in 2ms as a permissions problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-lock-"));
    dirs.push(dir);
    const legacyPath = join(dir, "state.db");
    const targetPath = join(dir, "mcx.db");
    writeLegacyDb(legacyPath);

    // A concurrent writer holding the write lock — a leftover sqlite3 shell, a second
    // daemon. The probe used to give up in ~2.4ms with no wait at all and tell the user
    // to fix permissions on a database whose permissions were fine.
    const blocker = new Database(legacyPath, { readwrite: true, create: false });
    blocker.run("BEGIN IMMEDIATE");
    blocker.run("INSERT INTO daemon_state (key, value) VALUES ('blocker', '1')");

    const state = freshTargetDb(targetPath);
    open.push(state);
    const logs: string[] = [];
    const started = Date.now();
    const result = importLegacyState({
      db: state.database,
      legacyPath,
      targetPath,
      scopesDir: join(dir, "scopes"),
      legacyBusyTimeoutMs: 400,
      log: (m) => logs.push(m),
    });
    const elapsed = Date.now() - started;
    blocker.run("ROLLBACK");
    blocker.close();

    // It waited out the configured window instead of failing instantly...
    expect(elapsed).toBeGreaterThanOrEqual(350);
    // ...and when the lock genuinely does not clear, the outcome is still safe:
    // nothing copied, marker withheld, retried next start.
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("not writable");
    expect(state.database.query<{ n: number }, []>("SELECT count(*) AS n FROM mail").get()?.n).toBe(0);
  });

  test("the default wait is 3s, not the 2ms that misdiagnosed contention", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-lock2-"));
    dirs.push(dir);
    const legacyPath = join(dir, "state.db");
    writeLegacyDb(legacyPath);
    const legacy = new Database(legacyPath, { readwrite: true, create: false });
    legacy.exec("PRAGMA busy_timeout = 3000");
    expect(legacy.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(3000);
    legacy.close();
  });
});

describe("cleanup cannot poison the shared connection (#3143 stacked-PR review)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function ws() {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-detach-"));
    dirs.push(dir);
    return { dir, legacyPath: join(dir, "state.db"), targetPath: join(dir, "mcx.db") };
  }

  test("the handle is left usable and out of a transaction after a FAILED import", () => {
    const w = ws();
    writeLegacyDb(w.legacyPath);
    const state = freshTargetDb(w.targetPath);
    open.push(state);
    state.database.run("DROP TABLE notes"); // force the rollback path

    importLegacyState({
      db: state.database,
      legacyPath: w.legacyPath,
      targetPath: w.targetPath,
      scopesDir: join(w.dir, "scopes"),
      log: () => {},
    });

    // DETACH while a transaction is open SUCCEEDS silently on bun's SQLite, so the
    // failure mode is a shared handle stuck mid-transaction rather than a thrown error.
    expect(state.database.inTransaction).toBe(false);
    // The daemon's only connection must still work, and `legacy` must be released.
    expect(() => state.setState("after", "ok")).not.toThrow();
    expect(state.getState("after")).toBe("ok");
    expect(() => state.database.run("ATTACH DATABASE ? AS legacy", [w.legacyPath])).not.toThrow();
    state.database.run("DETACH DATABASE legacy");
  });

  test("the handle is left usable and out of a transaction after a SUCCESSFUL import", () => {
    const w = ws();
    writeLegacyDb(w.legacyPath);
    const state = freshTargetDb(w.targetPath);
    open.push(state);

    const result = importLegacyState({
      db: state.database,
      legacyPath: w.legacyPath,
      targetPath: w.targetPath,
      scopesDir: join(w.dir, "scopes"),
      log: () => {},
    });
    expect(result.sealed).toBe(true);
    expect(state.database.inTransaction).toBe(false);
    expect(() => state.database.run("ATTACH DATABASE ? AS legacy", [w.legacyPath])).not.toThrow();
    state.database.run("DETACH DATABASE legacy");
  });
});

describe("every write is inside the transaction boundary (#3143 enumeration)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** Full content fingerprint of a database: every table and its row count. */
  function fingerprint(path: string): Record<string, number> {
    const db = new Database(path, { readonly: true });
    const out: Record<string, number> = {};
    for (const t of db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()) {
      out[t.name] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t.name}"`).get()?.n ?? 0;
    }
    db.close();
    return out;
  }

  test("a failed import leaves BOTH databases exactly as it found them", () => {
    // This is the enumeration expressed as a property rather than a list. Every mutating
    // statement in the import — domains, the 17 table copies, the derived cursor, the
    // marker and its row count (both in the LEGACY db), and the writability probe's
    // temp table — must be undone or never have landed. A future write added outside the
    // BEGIN fails here without anyone remembering to extend a list.
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-boundary-"));
    dirs.push(dir);
    const legacyPath = join(dir, "state.db");
    const targetPath = join(dir, "mcx.db");
    const scopesDir = join(dir, "scopes");
    writeLegacyDb(legacyPath);
    mkdirSync(scopesDir, { recursive: true });
    writeFileSync(join(scopesDir, "phoenix.json"), JSON.stringify({ root: "/home/u/github/phoenix" }));

    const state = freshTargetDb(targetPath);
    open.push(state);
    state.database.run("DROP TABLE notes"); // one table fails => the whole import rolls back

    const legacyBefore = fingerprint(legacyPath);
    const targetBefore = fingerprint(targetPath);

    const result = importLegacyState({
      db: state.database,
      legacyPath,
      targetPath,
      scopesDir,
      log: () => {},
    });

    expect(result.sealed).toBe(false);
    expect(result.failedTables).toContain("notes");
    // The legacy database must be untouched — no marker, no row count, no probe table.
    expect(fingerprint(legacyPath)).toEqual(legacyBefore);
    // ...and the target must hold nothing: no copied rows, no domains, no cursor.
    expect(fingerprint(targetPath)).toEqual(targetBefore);
  });

  test("a successful import writes the marker AND the row count, both in the legacy db", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-boundary2-"));
    dirs.push(dir);
    const legacyPath = join(dir, "state.db");
    const targetPath = join(dir, "mcx.db");
    writeLegacyDb(legacyPath);
    const state = freshTargetDb(targetPath);
    open.push(state);

    const result = importLegacyState({
      db: state.database,
      legacyPath,
      targetPath,
      scopesDir: join(dir, "scopes"),
      log: () => {},
    });
    expect(result.sealed).toBe(true);

    const legacy = new Database(legacyPath, { readonly: true });
    const keys = legacy
      .query<{ key: string }, []>("SELECT key FROM daemon_state WHERE key LIKE 'mcx_domain_import%' ORDER BY key")
      .all()
      .map((r) => r.key);
    // No leftover probe table on the success path either.
    const probe = legacy
      .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'mcx_import_write_probe'")
      .get()?.n;
    legacy.close();

    expect(keys).toEqual([IMPORT_MARKER_KEY, "mcx_domain_import_rows"]);
    expect(probe).toBe(0);
  });
});

describe("clampDerivedCursor bounds on the LEGACY range (#3143 stacked-PR blocker)", () => {
  const dirs: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("live events above the imported range are NOT skipped", () => {
    // The two maxima must differ or the test cannot fail: legacy holds seq 1-5, the
    // target already holds seq 100-190. Reading main. parks the cursor at 190 and
    // permanently skips 90 live events; reading legacy. parks it at 5, which is exactly
    // the imported history and nothing more.
    const dir = mkdtempSync(join(tmpdir(), "mcx-import-clamp-"));
    dirs.push(dir);
    const legacyPath = join(dir, "state.db");
    const targetPath = join(dir, "mcx.db");

    const legacy = new Database(legacyPath, { create: true });
    legacy.exec(`
      CREATE TABLE daemon_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE monitor_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, src TEXT NOT NULL, event TEXT NOT NULL,
        category TEXT NOT NULL, work_item_id TEXT, session_id TEXT, pr_number INTEGER, payload TEXT NOT NULL
      );
    `);
    for (let i = 1; i <= 5; i++) {
      legacy.run(
        "INSERT INTO monitor_events (seq, ts, src, event, category, payload) VALUES (?, ?, 'legacy', 'e', 'server', '{}')",
        [i, `2026-01-0${i}T00:00:00.000Z`],
      );
    }
    legacy.close();

    const state = freshTargetDb(targetPath);
    open.push(state);
    // Live events already in the target, in a disjoint, higher seq range.
    for (let i = 100; i <= 190; i++) {
      state.database.run(
        "INSERT INTO monitor_events (seq, ts, src, event, category, payload) VALUES (?, ?, 'live', 'e', 'server', '{}')",
        [i, "2026-02-01T00:00:00.000Z"],
      );
    }

    const result = importLegacyState({
      db: state.database,
      legacyPath,
      targetPath,
      scopesDir: join(dir, "scopes"),
      log: () => {},
    });
    expect(result.failedTables).toEqual([]);

    const cursor = state.database
      .query<{ last_seq: number }, []>("SELECT last_seq FROM derived_cursor WHERE id = 'derived_publisher'")
      .get();
    expect(cursor?.last_seq).toBe(5);
    // Sanity: the two maxima really are distinguishable, so this test can fail.
    expect(state.database.query<{ m: number }, []>("SELECT MAX(seq) AS m FROM monitor_events").get()?.m).toBe(190);
  });
});
