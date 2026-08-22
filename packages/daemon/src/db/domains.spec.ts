import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NO_DOMAIN_ID, options } from "@mcp-cli/core";
import { migrateDerivedCursor } from "../derived-events";
import { EventLog } from "../event-log";
import { StateDb } from "./state";
import { WorkItemDb } from "./work-items";

const repoRoot = resolve(import.meta.dir, "../../../..");

/** Every table this schema partitions by domain. */
const PARTITIONED_TABLES = [
  "work_items",
  "work_item_transitions",
  "ci_run_states",
  "mail",
  "agent_sessions",
  "alias_state",
  "aliases",
  "copilot_comment_state",
  "monitor_events",
  "derived_cursor",
] as const;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Partitioned tables with a NATURAL key — a value that repeats across projects (an issue
 * number, a branch, a PR number, an alias name, a state key). These MUST include
 * domain_id in their uniqueness or two domains collide.
 */
const NATURAL_KEYED_TABLES = [
  "work_items",
  "ci_run_states",
  "alias_state",
  "aliases",
  "copilot_comment_state",
  "derived_cursor",
] as const;

/**
 * Partitioned tables keyed by a SURROGATE that is already globally unique, so no
 * cross-domain collision is possible and domain_id is for filtering, not identity.
 * Mapped to the column that must be their sole primary key — asserted below, so the
 * exemption is verified rather than claimed.
 */
const SURROGATE_KEYED_TABLES: Record<string, string> = {
  mail: "id",
  agent_sessions: "session_id",
  monitor_events: "seq",
  work_item_transitions: "id",
};

function tmpDbPath(): string {
  return join(tmpdir(), `mcp-cli-domains-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
      // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
    } catch {
      /* ignore */
    }
  }
}

describe("domain schema", () => {
  const paths: string[] = [];
  const open: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  function createStateDb(): StateDb {
    const p = tmpDbPath();
    paths.push(p);
    const db = new StateDb(p);
    open.push(db);
    return db;
  }

  function columnsOf(db: Database, table: string): Set<string> {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  }

  test("the daemon opens mcx.db; state.db is only the import's source", () => {
    expect(basename(options.DB_PATH)).toBe("mcx.db");
    expect(basename(options.LEGACY_DB_PATH)).toBe("state.db");
  });

  test("only the one-shot import may reference LEGACY_DB_PATH", async () => {
    // Eleven issues unblock on this schema; the constraint that none of them reopens
    // the old database is a test, not a sentence in a PR description.
    const allowed = new Set(["packages/core/src/constants.ts", "packages/daemon/src/db/import-legacy.ts"]);
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: repoRoot })) {
      if (file.endsWith(".spec.ts") || allowed.has(file)) continue;
      if ((await Bun.file(join(repoRoot, file)).text()).includes("LEGACY_DB_PATH")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("domains table exists with exactly the designed columns and no state column", () => {
    const state = createStateDb();
    const cols = columnsOf(state.database, "domains");
    expect([...cols].sort()).toEqual(["created_at", "host", "id", "name", "path"]);
    // A domain does not know whether anything is running — see docs/domains.md.
    expect(cols.has("state")).toBe(false);
    expect(cols.has("status")).toBe(false);
  });

  /**
   * Every table that carries `domain_id` must include it in the PRIMARY KEY or in a
   * UNIQUE index. A `domain_id` column with the partition enforced on something else is
   * the exact bug this schema exists to kill — `aliases` shipped that way in the first
   * revision of this PR and a column-existence test reported green on it.
   */
  function partitionEnforcedBy(db: Database, table: string): string | null {
    // PK columns: PRAGMA table_info exposes `pk` as a 1-based position within the PK.
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    if (cols.some((c) => c.name === "domain_id" && c.pk > 0)) return "PRIMARY KEY";

    // Otherwise a UNIQUE index must include it.
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
    for (const idx of indexes) {
      if (idx.unique !== 1) continue;
      const members = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string | null }>;
      if (members.some((m) => m.name === "domain_id")) return `UNIQUE index ${idx.name}`;
    }
    return null;
  }

  test("every partitioned table carries domain_id", () => {
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    new EventLog(raw);
    migrateDerivedCursor(raw);

    for (const table of PARTITIONED_TABLES) {
      expect(columnsOf(raw, table).has("domain_id")).toBe(true);
    }
  });

  test("every partitioned table ENFORCES the partition, not just the column", () => {
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    new EventLog(raw);
    migrateDerivedCursor(raw);

    const unenforced: string[] = [];
    for (const table of NATURAL_KEYED_TABLES) {
      if (partitionEnforcedBy(raw, table) === null) unenforced.push(table);
    }
    expect(unenforced).toEqual([]);
  });

  test("the surrogate-keyed exemption is verified, not merely claimed", () => {
    // A table is exempt from partition-enforcement only because its key is a surrogate
    // that is already globally unique (an AUTOINCREMENT rowid or a generated id), so no
    // two domains can collide on it. Prove that rather than trusting the list — otherwise
    // the exemption set is just a loophole for the next natural-keyed table.
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    new EventLog(raw);
    migrateDerivedCursor(raw);

    for (const [table, surrogate] of Object.entries(SURROGATE_KEYED_TABLES)) {
      const pk = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
      expect({ table, pk }).toEqual({ table, pk: [surrogate] });
    }
  });

  test("every partitioned table is classified — an 11th cannot be added silently", () => {
    const classified = [...NATURAL_KEYED_TABLES, ...Object.keys(SURROGATE_KEYED_TABLES)].sort();
    expect(classified).toEqual([...PARTITIONED_TABLES].sort());
  });

  test("aliases are partitioned by domain — two domains can each own a phase named impl", () => {
    // Phases are stored as aliases. Without (domain_id, name) in the key, the second
    // domain to run `mcx phase install` overwrites the first domain's bundled_js.
    const state = createStateDb();
    const alpha = state.createDomain("alpha", "/home/u/alpha");
    const beta = state.createDomain("beta", "/home/u/beta");

    state.saveAlias(
      "impl",
      "/a/impl.ts",
      "alpha impl",
      "defineAlias",
      undefined,
      undefined,
      "ALPHA_JS",
      undefined,
      undefined,
      null,
      true,
      undefined,
      true,
      alpha.id,
    );
    state.saveAlias(
      "impl",
      "/b/impl.ts",
      "beta impl",
      "defineAlias",
      undefined,
      undefined,
      "BETA_JS",
      undefined,
      undefined,
      null,
      true,
      undefined,
      true,
      beta.id,
    );

    expect(state.getAlias("impl", alpha.id)?.bundledJs).toBe("ALPHA_JS");
    expect(state.getAlias("impl", beta.id)?.bundledJs).toBe("BETA_JS");
    expect(state.listAliases(alpha.id).map((a) => a.description)).toEqual(["alpha impl"]);
    expect(state.listAliases(beta.id).map((a) => a.description)).toEqual(["beta impl"]);

    // Deleting one domain's phase leaves the other's intact.
    state.deleteAlias("impl", alpha.id);
    expect(state.getAlias("impl", alpha.id)).toBeUndefined();
    expect(state.getAlias("impl", beta.id)?.bundledJs).toBe("BETA_JS");
  });

  test("domain ids start at 1, so NO_DOMAIN_ID can never collide with a real domain", () => {
    const state = createStateDb();
    const first = state.createDomain("phoenix", "/home/u/github/phoenix");
    expect(first.id).toBeGreaterThan(NO_DOMAIN_ID);
  });

  describe("StateDb domain accessors", () => {
    test("create, get, list, rename, delete", () => {
      const state = createStateDb();
      const phoenix = state.createDomain("phoenix", "/home/u/github/phoenix");
      expect(phoenix.name).toBe("phoenix");
      expect(phoenix.host).toBeNull();
      expect(phoenix.path).toBe("/home/u/github/phoenix");
      expect(phoenix.createdAt).toBeTruthy();

      const remote = state.createDomain("work", "~/work", "boxen0010");
      expect(remote.host).toBe("boxen0010");
      // Stored VERBATIM: ~/work is a path on boxen0010, so normalizing it against this
      // filesystem would store a local cwd-relative path for a remote directory (#3034
      // review 7). The previous revision did exactly that and this test never looked.
      expect(remote.path).toBe("~/work");

      expect(state.getDomainByName("phoenix")).toEqual(phoenix);
      expect(state.getDomainById(phoenix.id)).toEqual(phoenix);
      expect(state.getDomainByName("nope")).toBeNull();
      expect(state.listDomains().map((d) => d.name)).toEqual(["phoenix", "work"]);

      expect(state.renameDomain("phoenix", "octovalve")).toBe(true);
      expect(state.getDomainByName("phoenix")).toBeNull();
      expect(state.getDomainByName("octovalve")?.id).toBe(phoenix.id);
      expect(state.renameDomain("ghost", "x")).toBe(false);

      expect(state.deleteDomain("octovalve")).toBe(true);
      expect(state.deleteDomain("octovalve")).toBe(false);
      expect(state.listDomains().map((d) => d.name)).toEqual(["work"]);
    });

    test("a trailing slash on the registered path is normalized away", () => {
      const state = createStateDb();
      const d = state.createDomain("phoenix", "/home/u/github/phoenix/");
      expect(d.path).toBe("/home/u/github/phoenix");
    });

    test("rejects an invalid domain name rather than storing an unaddressable one", () => {
      const state = createStateDb();
      expect(() => state.createDomain("has space", "/tmp/x")).toThrow(/invalid domain name/);
      expect(() => state.createDomain("ok", "/tmp/x")).not.toThrow();
      expect(() => state.renameDomain("ok", "has/slash")).toThrow(/invalid domain name/);
    });

    test("duplicate names are rejected", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/home/u/a");
      expect(() => state.createDomain("phoenix", "/home/u/b")).toThrow();
    });

    test("two local domains cannot share a location", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/home/u/a");
      // NULL host must not defeat the uniqueness index.
      expect(() => state.createDomain("other", "/home/u/a")).toThrow();
      // Same path on a different host is a different location, and is allowed.
      expect(() => state.createDomain("remote", "/home/u/a", "boxen0010")).not.toThrow();
      expect(() => state.createDomain("remote2", "/home/u/a", "boxen0010")).toThrow();
    });

    test("resolveDomain walks up to the nearest registered domain", () => {
      const state = createStateDb();
      const outer = state.createDomain("outer", "/home/u/github");
      const inner = state.createDomain("inner", "/home/u/github/phoenix");

      expect(state.resolveDomain("/home/u/github/phoenix/src")?.id).toBe(inner.id);
      expect(state.resolveDomain("/home/u/github/other")?.id).toBe(outer.id);
      expect(state.resolveDomain("/home/u")).toBeNull();
    });
  });

  describe("domain ids and deletion (#3034 review B6)", () => {
    test("a deleted domain's id is never reused, so nothing gets adopted", () => {
      const state = createStateDb();
      const raw = state.database;
      new WorkItemDb(raw);

      const alpha = state.createDomain("alpha", "/home/u/alpha");
      const beta = state.createDomain("beta", "/home/u/beta");
      expect(beta.id).toBe(alpha.id + 1);

      state.deleteDomain("beta");
      const gamma = state.createDomain("gamma", "/home/u/gamma");
      // Without AUTOINCREMENT, gamma would take beta's rowid and inherit its rows.
      expect(gamma.id).not.toBe(beta.id);
      expect(gamma.id).toBeGreaterThan(beta.id);
    });

    test("deleteDomain REFUSES while dependents exist, naming per-table counts", () => {
      const state = createStateDb();
      const raw = state.database;
      const wi = new WorkItemDb(raw);
      const beta = state.createDomain("beta", "/home/u/beta");

      const item = wi.createWorkItem({ issueNumber: 7 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [beta.id, item.id]);
      raw.run("INSERT INTO mail (sender, recipient, domain_id) VALUES ('a','b',?)", [beta.id]);

      expect(() => state.deleteDomain("beta")).toThrow(/still has 2 dependent row\(s\)/);
      expect(() => state.deleteDomain("beta")).toThrow(/work_items=1/);
      expect(() => state.deleteDomain("beta")).toThrow(/mail=1/);
      // Refusal leaves everything intact.
      expect(state.getDomainByName("beta")).not.toBeNull();
      expect(wi.getWorkItemByIssue(7, beta.id)?.id).toBe(item.id);
    });

    test("cascade deletes the dependents with the domain", () => {
      const state = createStateDb();
      const raw = state.database;
      const wi = new WorkItemDb(raw);
      const beta = state.createDomain("beta", "/home/u/beta");
      const keep = state.createDomain("keep", "/home/u/keep");

      const doomed = wi.createWorkItem({ issueNumber: 7 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [beta.id, doomed.id]);
      const survivor = wi.createWorkItem({ issueNumber: 8 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [keep.id, survivor.id]);

      expect(state.deleteDomain("beta", { cascade: true })).toBe(true);
      expect(state.getDomainByName("beta")).toBeNull();
      expect(wi.getWorkItemByIssue(7, beta.id)).toBeNull();
      // Another domain's rows are untouched.
      expect(wi.getWorkItemByIssue(8, keep.id)?.id).toBe(survivor.id);
    });

    test("created_at is a single sortable format across CLI and import paths", () => {
      const state = createStateDb();
      const d = state.createDomain("alpha", "/home/u/alpha");
      // ISO-8601 with a Z, matching what the importer writes — mixing this with
      // datetime('now') made any ORDER BY created_at sort imported domains as a block.
      expect(d.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("resolveDomain matches through a symlinked path", () => {
      const state = createStateDb();
      const real = mkdtempSync(join(tmpdir(), "mcx-dom-real-"));
      const link = join(tmpdir(), `mcx-dom-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
      symlinkSync(real, link);
      try {
        const d = state.createDomain("proj", real);
        // Querying via the symlink must find the domain registered by its real path.
        expect(state.resolveDomain(join(link, "src"))?.id).toBe(d.id);
      } finally {
        unlinkSync(link);
        rmSync(real, { recursive: true, force: true });
      }
    });
  });

  describe("per-domain uniqueness", () => {
    test("two domains can each own a work item with issue_number = 42", () => {
      const state = createStateDb();
      const raw = state.database;
      const alpha = state.createDomain("alpha", "/home/u/alpha");
      const beta = state.createDomain("beta", "/home/u/beta");
      const wi = new WorkItemDb(raw);

      // Create then assign one at a time: the unassigned partition is itself unique,
      // so both cannot sit in domain 0 at the same moment. (#3037 makes createWorkItem
      // take a domain directly; until then the column default is 0.)
      const a = wi.createWorkItem({ issueNumber: 42, branch: "fix/issue-42", prNumber: 7 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [alpha.id, a.id]);
      const b = wi.createWorkItem({ issueNumber: 42, branch: "fix/issue-42", prNumber: 7 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [beta.id, b.id]);

      expect(wi.getWorkItemByIssue(42, alpha.id)?.id).toBe(a.id);
      expect(wi.getWorkItemByIssue(42, beta.id)?.id).toBe(b.id);
      expect(wi.getWorkItemByBranch("fix/issue-42", alpha.id)?.id).toBe(a.id);
      expect(wi.getWorkItemByBranch("fix/issue-42", beta.id)?.id).toBe(b.id);
      expect(wi.getWorkItemByPr(7, alpha.id)?.id).toBe(a.id);
      expect(wi.getWorkItemByPr(7, beta.id)?.id).toBe(b.id);
    });

    test("uniqueness still bites inside a single domain", () => {
      const state = createStateDb();
      const raw = state.database;
      const alpha = state.createDomain("alpha", "/home/u/alpha");
      const wi = new WorkItemDb(raw);

      const a = wi.createWorkItem({ issueNumber: 42 });
      raw.run("UPDATE work_items SET domain_id = ? WHERE id = ?", [alpha.id, a.id]);
      const b = wi.createWorkItem({ issueNumber: 43 });
      expect(() =>
        raw.run("UPDATE work_items SET domain_id = ?, issue_number = 42 WHERE id = ?", [alpha.id, b.id]),
      ).toThrow();
    });

    test("uniqueness bites in the unassigned partition too — NULL would have dropped it", () => {
      const state = createStateDb();
      const wi = new WorkItemDb(state.database);
      wi.createWorkItem({ issueNumber: 42 });
      expect(() => wi.createWorkItem({ issueNumber: 42 })).toThrow();
    });

    test("alias_state is keyed per domain", () => {
      const state = createStateDb();
      const raw = state.database;
      raw.run("INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)", [
        1,
        "/repo",
        "ns",
        "k",
        '"alpha"',
      ]);
      raw.run("INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)", [
        2,
        "/repo",
        "ns",
        "k",
        '"beta"',
      ]);
      const rows = raw
        .query<{ domain_id: number; value_json: string }, []>(
          "SELECT domain_id, value_json FROM alias_state ORDER BY domain_id",
        )
        .all();
      expect(rows).toEqual([
        { domain_id: 1, value_json: '"alpha"' },
        { domain_id: 2, value_json: '"beta"' },
      ]);
      // Same key twice within one domain still collides.
      expect(() =>
        raw.run("INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)", [
          1,
          "/repo",
          "ns",
          "k",
          '"dup"',
        ]),
      ).toThrow();
    });

    test("copilot comment state is keyed per domain", () => {
      const state = createStateDb();
      state.updateSeenCommentIds(42, [1, 2], 1);
      state.updateSeenCommentIds(42, [9], 2);
      expect(state.getSeenCommentIds(42, 1)).toEqual([1, 2]);
      expect(state.getSeenCommentIds(42, 2)).toEqual([9]);
      expect(state.getSeenCommentIds(42)).toEqual([]);

      state.updateLastRepoPollTs("2026-08-22T00:00:00Z", 1);
      state.updateLastRepoPollTs("2026-08-21T00:00:00Z", 2);
      expect(state.getLastRepoPollTs(1)).toBe("2026-08-22T00:00:00Z");
      expect(state.getLastRepoPollTs(2)).toBe("2026-08-21T00:00:00Z");
      expect(state.getLastRepoPollTs()).toBeNull();

      expect(state.deleteCopilotCommentState(42, 1)).toBe(true);
      expect(state.getSeenCommentIds(42, 1)).toEqual([]);
      expect(state.getSeenCommentIds(42, 2)).toEqual([9]);
    });

    test("ci run states are keyed per domain", () => {
      const state = createStateDb();
      const wi = new WorkItemDb(state.database);
      wi.upsertCiRunState(42, { suiteId: 1, startedAt: 100, emittedStarted: true, emittedFinished: false }, 1);
      wi.upsertCiRunState(42, { suiteId: 2, startedAt: 200, emittedStarted: false, emittedFinished: false }, 2);
      expect(wi.loadCiRunStates(1).get(42)?.suiteId).toBe(1);
      expect(wi.loadCiRunStates(2).get(42)?.suiteId).toBe(2);
      wi.deleteCiRunState(42, 1);
      expect(wi.loadCiRunStates(1).size).toBe(0);
      expect(wi.loadCiRunStates(2).size).toBe(1);
    });
  });
});
