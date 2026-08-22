/**
 * The startup order that makes the upgrade path work — asserted, not commented.
 *
 * `index.ts` must call `adoptSessionsIntoDomains()` AFTER `importLegacyState` and
 * BEFORE sessions are restored. Both directions are load-bearing and neither was
 * covered: the reviewer drove the reversed order by hand and got `adopted = 0` with
 * every restored session sitting at the sentinel, invisible to `-d` — the exact
 * regression the backfill exists to fix, reinstated silently, with nothing in the
 * suite failing. A comment was holding up the fix.
 *
 * These tests drive a real legacy database with a real scope sidecar and real
 * pre-existing sessions, and assert the two orders produce different answers.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { importLegacyState } from "./import-legacy";
import { StateDb } from "./state";

describe("adoption order (#3039)", () => {
  const dirs: string[] = [];
  const dbs: StateDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A legacy `state.db` holding two live sessions inside `projectRoot`, plus a
   * `mcx scope` sidecar naming that root — i.e. exactly the box of a user upgrading.
   */
  function makeWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "mcx-adopt-order-"));
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, "wt"), { recursive: true });

    const scopesDir = join(dir, "scopes");
    mkdirSync(scopesDir, { recursive: true });
    writeFileSync(join(scopesDir, "phoenix.json"), JSON.stringify({ root: projectRoot }));

    const legacyPath = join(dir, "state.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE agent_sessions (
        session_id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL DEFAULT 'claude',
        pid INTEGER, pid_start_time INTEGER, state TEXT NOT NULL DEFAULT 'connecting',
        model TEXT, cwd TEXT, worktree TEXT, repo_root TEXT,
        total_cost REAL NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        spawned_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
        claude_session_id TEXT, transport TEXT
      );
    `);
    legacy.run("INSERT INTO agent_sessions (session_id, cwd) VALUES (?, ?)", ["in-scope", join(projectRoot, "wt")]);
    legacy.run("INSERT INTO agent_sessions (session_id, repo_root) VALUES (?, ?)", ["by-repo", projectRoot]);
    legacy.run("INSERT INTO agent_sessions (session_id, cwd) VALUES (?, ?)", ["elsewhere", join(dir, "other")]);
    legacy.close();

    const target = new StateDb(join(dir, "mcx.db"));
    dbs.push(target);
    return { target, legacyPath, scopesDir, projectRoot };
  }

  test("import THEN adopt — the daemon's order — assigns the domain to the imported sessions", () => {
    const ws = makeWorkspace();

    const result = importLegacyState({
      db: ws.target.getDatabase(),
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(result.ran).toBe(true);

    const adopted = ws.target.adoptSessionsIntoDomains();
    expect(adopted).toBe(2);

    const phoenix = ws.target.getDomainByName("phoenix");
    expect(phoenix).not.toBeNull();
    expect(ws.target.getSession("in-scope")?.domainId).toBe(phoenix?.id);
    expect(ws.target.getSession("by-repo")?.domainId).toBe(phoenix?.id);
    // Outside the domain: left at the sentinel, never guessed at.
    expect(ws.target.getSession("elsewhere")?.domainId).toBe(NO_DOMAIN_ID);
  });

  test("adopt THEN import — the reversed order — adopts NOTHING and leaves every session invisible to -d", () => {
    // This is the failure the ordering comment describes. It must be a test, because
    // moving one line in index.ts reintroduces it and nothing else would notice.
    const ws = makeWorkspace();

    // Adoption first: the domains do not exist yet AND the sessions have not been
    // copied in yet, so there is nothing to match.
    expect(ws.target.adoptSessionsIntoDomains()).toBe(0);

    importLegacyState({
      db: ws.target.getDatabase(),
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });

    // The domain now exists and the sessions are now present — but nothing ever
    // connected them, and no further adoption runs this boot.
    expect(ws.target.getDomainByName("phoenix")).not.toBeNull();
    expect(ws.target.getSession("in-scope")?.domainId).toBe(NO_DOMAIN_ID);
    expect(ws.target.getSession("by-repo")?.domainId).toBe(NO_DOMAIN_ID);
  });

  test("adoption is idempotent across restarts", () => {
    const ws = makeWorkspace();
    importLegacyState({
      db: ws.target.getDatabase(),
      legacyPath: ws.legacyPath,
      scopesDir: ws.scopesDir,
      log: () => {},
    });
    expect(ws.target.adoptSessionsIntoDomains()).toBe(2);
    expect(ws.target.adoptSessionsIntoDomains()).toBe(0);
  });
});
