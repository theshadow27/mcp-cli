import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDerivedCursor } from "../derived-events";
import { EventLog } from "../event-log";
import { IMPORT_MARKER_KEY, importLegacyState } from "./import-legacy";
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
    expect(forced.totalCopied).toBe(0);
    expect(forced.totalSkipped).toBeGreaterThan(0);
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
