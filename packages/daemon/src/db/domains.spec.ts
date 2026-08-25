import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";

/**
 * A **canonical** temp root. `tmpdir()` is `/var/folders/...` on macOS and `/var` is a
 * symlink, so the raw value is not what the code under test stores: domain paths go
 * through `canonicalizeExistingDomainPath`, so a fixture built on the unresolved spelling
 * asserts against a path production never writes. Resolving once here keeps the only
 * symlink in a fixture the one a test creates on purpose.
 */
const tmpdir = (): string => realpathSync(osTmpdir());
import { basename, join, resolve } from "node:path";
import { NO_DOMAIN_ID, listPartitionedTables, options } from "@mcp-cli/core";
import { migrateDerivedCursor } from "../derived-events";
import { EventLog } from "../event-log";
import { DomainConflictError, DomainHasDependentsError, StateDb } from "./state";
import { WorkItemDb } from "./work-items";

const repoRoot = resolve(import.meta.dir, "../../../..");

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

    // Derived, not listed: this asserts the schema is self-consistent rather than
    // asserting a literal against itself.
    const derived = listPartitionedTables(raw);
    expect(derived.length).toBeGreaterThan(0);
    for (const table of derived) {
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
    // This used to compare three hardcoded literals in ONE file against each other and
    // never read the database, so an 11th partitioned table added to a live mcx.db was
    // missed entirely (#3034 review Y4). The classification is now checked against the
    // schema, so a table added without a decision fails here.
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    new EventLog(raw);
    migrateDerivedCursor(raw);

    const classified = [...NATURAL_KEYED_TABLES, ...Object.keys(SURROGATE_KEYED_TABLES)].sort();
    expect(classified).toEqual(listPartitionedTables(raw).sort());
  });

  test("the derivation catches a partitioned table nobody classified", () => {
    // Prove the check above is not another tautology: add an 11th partitioned table to a
    // live database and confirm the derived set grows while the hand-maintained
    // classification does not.
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    new EventLog(raw);
    migrateDerivedCursor(raw);

    const before = listPartitionedTables(raw);
    raw.exec("CREATE TABLE cards (domain_id INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL)");
    const after = listPartitionedTables(raw);

    expect(after).toContain("cards");
    expect(after.length).toBe(before.length + 1);
    const classified = [...NATURAL_KEYED_TABLES, ...Object.keys(SURROGATE_KEYED_TABLES)].sort();
    expect(classified).not.toEqual(after.sort());
  });

  test("countDomainDependents follows the schema, not a hand-maintained list", () => {
    // StateDb.DOMAIN_DEPENDENT_TABLES is gone; the refuse-with-counts invariant reads the
    // same derivation, so a new partitioned table is counted the moment it exists.
    const state = createStateDb();
    const raw = state.database;
    new WorkItemDb(raw);
    const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");

    raw.exec("CREATE TABLE cards (domain_id INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL)");
    raw.run("INSERT INTO cards (domain_id, slug) VALUES (?, 'c1')", [alpha.id]);

    expect(state.countDomainDependents(alpha.id)).toEqual([{ table: "cards", rows: 1 }]);
    expect(() => state.deleteDomain("alpha")).toThrow(/cards=1/);
  });

  test("aliases are partitioned by domain — two domains can each own a phase named impl", () => {
    // Phases are stored as aliases. Without (domain_id, name) in the key, the second
    // domain to run `mcx phase install` overwrites the first domain's bundled_js.
    const state = createStateDb();
    const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");
    const beta = state.createDomain("beta", "/mcx-test/u/beta");

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
    const first = state.createDomain("phoenix", "/mcx-test/u/github/phoenix");
    expect(first.id).toBeGreaterThan(NO_DOMAIN_ID);
  });

  describe("StateDb domain accessors", () => {
    test("create, get, list, rename, delete", () => {
      const state = createStateDb();
      const phoenix = state.createDomain("phoenix", "/mcx-test/u/github/phoenix");
      expect(phoenix.name).toBe("phoenix");
      expect(phoenix.host).toBeNull();
      expect(phoenix.path).toBe("/mcx-test/u/github/phoenix");
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

      // The renamed row comes back from the transaction that wrote it (#3210), so the
      // caller never re-reads a database that has moved since.
      expect(state.renameDomain("phoenix", "octovalve")?.id).toBe(phoenix.id);
      expect(state.getDomainByName("phoenix")).toBeNull();
      expect(state.getDomainByName("octovalve")?.id).toBe(phoenix.id);
      expect(state.renameDomain("ghost", "x")).toBeNull();

      expect(state.deleteDomain("octovalve")).toBe(true);
      expect(state.deleteDomain("octovalve")).toBe(false);
      expect(state.listDomains().map((d) => d.name)).toEqual(["work"]);
    });

    test("a trailing slash on the registered path is normalized away", () => {
      const state = createStateDb();
      const d = state.createDomain("phoenix", "/mcx-test/u/github/phoenix/");
      expect(d.path).toBe("/mcx-test/u/github/phoenix");
    });

    test("rejects an invalid domain name rather than storing an unaddressable one", () => {
      const state = createStateDb();
      expect(() => state.createDomain("has space", "/mcx-test/x")).toThrow(/invalid domain name/);
      expect(() => state.createDomain("ok", "/mcx-test/x")).not.toThrow();
      expect(() => state.renameDomain("ok", "has/slash")).toThrow(/invalid domain name/);
    });

    test("duplicate names are rejected", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/mcx-test/u/a");
      expect(() => state.createDomain("phoenix", "/mcx-test/u/b")).toThrow();
    });

    test("two local domains cannot share a location", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/mcx-test/u/a");
      // NULL host must not defeat the uniqueness index.
      expect(() => state.createDomain("other", "/mcx-test/u/a")).toThrow();
      // Same path on a different host is a different location, and is allowed.
      expect(() => state.createDomain("remote", "/mcx-test/u/a", "boxen0010")).not.toThrow();
      expect(() => state.createDomain("remote2", "/mcx-test/u/a", "boxen0010")).toThrow();
    });

    test("resolveDomain walks up to the nearest registered domain", () => {
      const state = createStateDb();
      const outer = state.createDomain("outer", "/mcx-test/u/github");
      const inner = state.createDomain("inner", "/mcx-test/u/github/phoenix");

      expect(state.resolveDomain("/mcx-test/u/github/phoenix/src")?.id).toBe(inner.id);
      expect(state.resolveDomain("/mcx-test/u/github/other")?.id).toBe(outer.id);
      expect(state.resolveDomain("/mcx-test/u")).toBeNull();
    });
  });

  describe("domain ids and deletion (#3034 review B6)", () => {
    test("a deleted domain's id is never reused, so nothing gets adopted", () => {
      const state = createStateDb();
      const raw = state.database;
      new WorkItemDb(raw);

      const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");
      const beta = state.createDomain("beta", "/mcx-test/u/beta");
      expect(beta.id).toBe(alpha.id + 1);

      state.deleteDomain("beta");
      const gamma = state.createDomain("gamma", "/mcx-test/u/gamma");
      // Without AUTOINCREMENT, gamma would take beta's rowid and inherit its rows.
      expect(gamma.id).not.toBe(beta.id);
      expect(gamma.id).toBeGreaterThan(beta.id);
    });

    test("deleteDomain REFUSES while dependents exist, naming per-table counts", () => {
      const state = createStateDb();
      const raw = state.database;
      const wi = new WorkItemDb(raw);
      const beta = state.createDomain("beta", "/mcx-test/u/beta");

      const item = wi.forDomain(beta.id).createWorkItem({ issueNumber: 7 });
      raw.run("INSERT INTO mail (sender, recipient, domain_id) VALUES ('a','b',?)", [beta.id]);

      // Three, not two: creating a work item also appends its first transition, and
      // that row carries domain_id now that #3037 gave the column a writer. Before that
      // fix every transition said domain_id = 0 and this count silently omitted them.
      expect(() => state.deleteDomain("beta")).toThrow(/still has 3 dependent row\(s\)/);
      expect(() => state.deleteDomain("beta")).toThrow(/work_items=1/);
      expect(() => state.deleteDomain("beta")).toThrow(/work_item_transitions=1/);
      expect(() => state.deleteDomain("beta")).toThrow(/mail=1/);
      // Refusal leaves everything intact.
      expect(state.getDomainByName("beta")).not.toBeNull();
      expect(wi.forDomain(beta.id).getWorkItemByIssue(7)?.id).toBe(item.id);
    });

    test("cascade deletes the dependents with the domain", () => {
      const state = createStateDb();
      const raw = state.database;
      const wi = new WorkItemDb(raw);
      const beta = state.createDomain("beta", "/mcx-test/u/beta");
      const keep = state.createDomain("keep", "/mcx-test/u/keep");

      wi.forDomain(beta.id).createWorkItem({ issueNumber: 7 });
      const survivor = wi.forDomain(keep.id).createWorkItem({ issueNumber: 8 });

      expect(state.deleteDomain("beta", { cascade: true })).toBe(true);
      expect(state.getDomainByName("beta")).toBeNull();
      expect(wi.forDomain(beta.id).getWorkItemByIssue(7)).toBeNull();
      // Another domain's rows are untouched.
      expect(wi.forDomain(keep.id).getWorkItemByIssue(8)?.id).toBe(survivor.id);
    });

    test("created_at is a single sortable format across CLI and import paths", () => {
      const state = createStateDb();
      const d = state.createDomain("alpha", "/mcx-test/u/alpha");
      // ISO-8601 with a Z, matching what the importer writes — mixing this with
      // datetime('now') made any ORDER BY created_at sort imported domains as a block.
      expect(d.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("the refusal is a TYPE carrying the counts it was decided on (#3180)", () => {
      const state = createStateDb();
      const beta = state.createDomain("beta", "/mcx-test/u/beta");
      state.database.run("INSERT INTO mail (sender, recipient, domain_id) VALUES ('a','b',?)", [beta.id]);

      try {
        state.deleteDomain("beta");
        throw new Error("expected deleteDomain to refuse while mail still references the domain");
      } catch (err) {
        // A plain Error would leave the caller re-counting the database to guess whether
        // it refused or broke — which is how a disk-full became "re-run with --force".
        expect(err).toBeInstanceOf(DomainHasDependentsError);
        if (!(err instanceof DomainHasDependentsError)) throw err;
        expect(err.domainName).toBe("beta");
        expect(err.dependents).toEqual([{ table: "mail", rows: 1 }]);
        // The prose stays the contract it always was for humans, just no longer for code.
        expect(err.message).toMatch(/still has 1 dependent row\(s\) \(mail=1\)/);
      }
    });

    test("the delete transaction is IMMEDIATE: no snapshot to lose on the read→write upgrade (#3180)", () => {
      // deleteDomain reads (countDomainDependents) and then writes. Under BEGIN DEFERRED
      // the write lock is taken at the first WRITE, so a writer that commits in between
      // invalidates the read snapshot and the upgrade fails SQLITE_BUSY_SNAPSHOT — which
      // busy_timeout does NOT retry. This test drives a commit into exactly that window.
      const p = tmpDbPath();
      paths.push(p);
      const state = new StateDb(p);
      open.push(state);
      const beta = state.createDomain("beta", "/mcx-test/u/beta");
      state.database.run("INSERT INTO mail (sender, recipient, domain_id) VALUES ('a','b',?)", [beta.id]);

      // A second connection on the same file. busy_timeout 0 so this single-threaded test
      // records the lockout immediately instead of sitting out the daemon's real 3s.
      const other = new StateDb(p);
      open.push(other);
      other.database.exec("PRAGMA busy_timeout = 0");

      const interleaved: string[] = [];
      const racing = Object.create(state) as StateDb;
      Object.defineProperty(racing, "countDomainDependents", {
        value: (id: number) => {
          // Delegate FIRST: under DEFERRED the read snapshot is taken by this call, not by
          // BEGIN, so a commit racing in before it is no race at all. The window that
          // matters opens once the transaction has read something.
          const counts = StateDb.prototype.countDomainDependents.call(state, id);
          try {
            other.database.run("INSERT INTO mail (sender, recipient, domain_id) VALUES ('c','d',0)");
            interleaved.push("committed");
          } catch (err) {
            // The lockout is the fix working: IMMEDIATE already holds the write lock, so
            // the contender waits (busy_timeout 0 here) instead of moving the snapshot.
            expect((err as { code?: string }).code).toBe("SQLITE_BUSY");
            interleaved.push("locked-out");
          }
          return counts;
        },
      });

      // With IMMEDIATE the write lock is already held at BEGIN, so the contender is the
      // one that has to wait and this delete completes. With DEFERRED the contender
      // commits ("committed") and the delete throws SQLITE_BUSY_SNAPSHOT instead.
      expect(racing.deleteDomain("beta", { cascade: true })).toBe(true);
      expect(interleaved).toEqual(["locked-out"]);
      expect(state.getDomainByName("beta")).toBeNull();
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

  describe("review round 2 — Y5/Y6", () => {
    test("Y5: work_item_transitions inherit their parent's domain, so counts do not lie", () => {
      const state = createStateDb();
      const raw = state.database;
      const wi = new WorkItemDb(raw);
      const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");

      const items = wi.forDomain(alpha.id);
      const item = items.createWorkItem({ issueNumber: 7 });
      items.recordTransition(item.id, "impl", "qa", false);
      items.recordTransition(item.id, "qa", "done", false);

      // #3037 closed the gap this test used to carve out: the work item is created IN the
      // domain, so the creation transition carries it too. All three rows, not just the
      // two recorded after a post-hoc UPDATE.
      const rows = raw
        .query<{ domain_id: number }, []>("SELECT domain_id FROM work_item_transitions ORDER BY id")
        .all();
      expect(rows).toEqual([{ domain_id: alpha.id }, { domain_id: alpha.id }, { domain_id: alpha.id }]);

      // The count that deleteDomain's refusal is built on must see them — it previously
      // reported a confident zero because every row was at 0.
      const counts = state.countDomainDependents(alpha.id);
      expect(counts).toContainEqual({ table: "work_item_transitions", rows: 3 });
      expect(() => state.deleteDomain("alpha")).toThrow(/work_item_transitions=3/);

      // ...and a cascade takes that history with the item rather than orphaning it.
      state.deleteDomain("alpha", { cascade: true });
      expect(raw.query<{ n: number }, []>("SELECT count(*) AS n FROM work_item_transitions").get()?.n).toBe(0);
    });

    test("Y5: a transition for an unassigned work item stays at the sentinel", () => {
      const state = createStateDb();
      const wi = new WorkItemDb(state.database).forDomain(NO_DOMAIN_ID);
      const item = wi.createWorkItem({ issueNumber: 8 });
      wi.recordTransition(item.id, null, "impl", false);
      expect(
        state.database.query<{ domain_id: number }, []>("SELECT domain_id FROM work_item_transitions").get()?.domain_id,
      ).toBe(NO_DOMAIN_ID);
    });

    test("Y6: an empty or malformed host is rejected instead of taking the remote branch", () => {
      const state = createStateDb();
      // "" used to be remote for canonicalization (stored verbatim, never checked for
      // absoluteness) and local for uniqueness (COALESCE(host,'')) at the same time.
      expect(() => state.createDomain("empty", "relative/not/absolute", "")).toThrow(/invalid domain host/);
      expect(() => state.createDomain("blank", "/mcx-test/x", "   ")).toThrow(/invalid domain host/);
      expect(() => state.createDomain("slashy", "/mcx-test/x", "has/slash")).toThrow(/invalid domain host/);
      // A real host still works, and is stored verbatim.
      const remote = state.createDomain("work", "~/work", "boxen0010");
      expect(remote.path).toBe("~/work");
      // ...and null is still how a local domain is spelled.
      expect(state.createDomain("local", "/tmp").host).toBeNull();
    });
  });

  describe("per-domain uniqueness", () => {
    test("two domains can each own a work item with issue_number = 42", () => {
      const state = createStateDb();
      const raw = state.database;
      const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");
      const beta = state.createDomain("beta", "/mcx-test/u/beta");
      const wi = new WorkItemDb(raw);

      // Each domain writes through its own handle (#3037) — no post-hoc UPDATE to move
      // the row, because there is no API that could.
      const a = wi.forDomain(alpha.id).createWorkItem({ issueNumber: 42, branch: "fix/issue-42", prNumber: 7 });
      const b = wi.forDomain(beta.id).createWorkItem({ issueNumber: 42, branch: "fix/issue-42", prNumber: 7 });
      expect(a.id).not.toBe(b.id);

      expect(wi.forDomain(alpha.id).getWorkItemByIssue(42)?.id).toBe(a.id);
      expect(wi.forDomain(beta.id).getWorkItemByIssue(42)?.id).toBe(b.id);
      expect(wi.forDomain(alpha.id).getWorkItemByBranch("fix/issue-42")?.id).toBe(a.id);
      expect(wi.forDomain(beta.id).getWorkItemByBranch("fix/issue-42")?.id).toBe(b.id);
      expect(wi.forDomain(alpha.id).getWorkItemByPr(7)?.id).toBe(a.id);
      expect(wi.forDomain(beta.id).getWorkItemByPr(7)?.id).toBe(b.id);
    });

    test("uniqueness still bites inside a single domain", () => {
      const state = createStateDb();
      const raw = state.database;
      const alpha = state.createDomain("alpha", "/mcx-test/u/alpha");
      const wi = new WorkItemDb(raw);

      wi.forDomain(alpha.id).createWorkItem({ issueNumber: 42 });
      expect(() => wi.forDomain(alpha.id).createWorkItem({ issueNumber: 42 })).toThrow();
    });

    test("uniqueness bites in the unassigned partition too — NULL would have dropped it", () => {
      const state = createStateDb();
      const wi = new WorkItemDb(state.database).forDomain(NO_DOMAIN_ID);
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
      wi.forDomain(1).upsertCiRunState(42, {
        suiteId: 1,
        startedAt: 100,
        emittedStarted: true,
        emittedFinished: false,
      });
      wi.forDomain(2).upsertCiRunState(42, {
        suiteId: 2,
        startedAt: 200,
        emittedStarted: false,
        emittedFinished: false,
      });
      expect(wi.forDomain(1).loadCiRunStates().get(42)?.suiteId).toBe(1);
      expect(wi.forDomain(2).loadCiRunStates().get(42)?.suiteId).toBe(2);
      wi.forDomain(1).deleteCiRunState(42);
      expect(wi.forDomain(1).loadCiRunStates().size).toBe(0);
      expect(wi.forDomain(2).loadCiRunStates().size).toBe(1);
    });
  });

  describe("the schema claims only what it enforces (#3180)", () => {
    test("a NEW database declares no foreign key, because nothing turns enforcement on", () => {
      const state = createStateDb();
      const raw = state.database;

      // `mail.reply_to REFERENCES mail(id)` was the only FK in this schema, and
      // `PRAGMA foreign_keys` is set nowhere in db/ — SQLite defaults it OFF, so the
      // clause was decorative. Both halves are asserted: a future PR that adds the
      // clause back without enabling enforcement fails here.
      //
      // Scope, deliberately: pre-#3180 databases still declare it. Dropping a constraint
      // in SQLite means rebuilding the table, and that is not a price worth paying for a
      // declaration nothing reads — see the comment in applyV1Schema.
      expect(raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
      expect(raw.query<{ from: string }, []>("PRAGMA foreign_key_list(mail)").all()).toEqual([]);

      // The proof it never enforced anything: a reply pointing at an id that does not
      // exist inserts happily. Before this change `foreign_key_check` then listed the
      // row as a violation of a constraint the database had already let through.
      raw.run("INSERT INTO mail (sender, recipient, domain_id, reply_to) VALUES ('a','b',0,999999)");
      expect(raw.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  /**
   * #3210. The collision check and the write used to be two steps in `handlers/domain.ts`,
   * so two writers could both pass the check and the loser got a bare
   * `SQLITE_CONSTRAINT_UNIQUE` — the raw error the check exists to replace.
   */
  describe("a registration collision is decided inside the write (#3210)", () => {
    test("a duplicate name is a typed refusal that names where the existing domain lives", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/srv/phoenix");

      try {
        state.createDomain("phoenix", "/srv/other");
        expect.unreachable("should have thrown DomainConflictError");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainConflictError);
        const conflict = err as DomainConflictError;
        expect(conflict.conflict).toBe("name");
        // The conflicting row itself, as read inside the transaction that refused — not a
        // message the caller has to parse back apart (`no-error-message-sniffing`).
        expect(conflict.existing.path).toBe("/srv/phoenix");
        expect(conflict.message).toContain('domain "phoenix" already exists at /srv/phoenix');
      }
    });

    test("a duplicate location is a typed refusal that names the owner", () => {
      const state = createStateDb();
      state.createDomain("phoenix", "/srv/phoenix");

      try {
        state.createDomain("second", "/srv/phoenix");
        expect.unreachable("should have thrown DomainConflictError");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainConflictError);
        expect((err as DomainConflictError).conflict).toBe("location");
        expect((err as DomainConflictError).existing.name).toBe("phoenix");
        expect((err as Error).message).toContain('/srv/phoenix is already domain "phoenix"');
      }
    });

    test("a location taken by ANOTHER connection still refuses by name, not by raw constraint", () => {
      // The actual concurrency shape, and the one test here that fails on the old code:
      // with the check outside the write, this connection had already passed it, so the
      // insert reached the UNIQUE index and surfaced `SQLITE_CONSTRAINT_UNIQUE`. The check
      // now happens under the same write lock as the insert, so the row the other writer
      // committed is visible to the decision that refuses.
      const p = tmpDbPath();
      paths.push(p);
      const mine = new StateDb(p);
      open.push(mine);
      const theirs = new StateDb(p);
      open.push(theirs);

      theirs.createDomain("beta", "/srv/shared");

      try {
        mine.createDomain("alpha", "/srv/shared");
        expect.unreachable("should have thrown DomainConflictError");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainConflictError);
        expect((err as Error).message).toContain('already domain "beta"');
        // Not the raw index error: `SQLITE_CONSTRAINT_UNIQUE` is what this used to be.
        expect((err as { code?: string }).code).toBeUndefined();
      }
    });

    test("rename to an occupied name is the same typed refusal, and nothing moves", () => {
      const state = createStateDb();
      const a = state.createDomain("a", "/srv/a");
      state.createDomain("b", "/srv/b");

      try {
        state.renameDomain("a", "b");
        expect.unreachable("should have thrown DomainConflictError");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainConflictError);
        expect((err as DomainConflictError).existing.name).toBe("b");
      }
      expect(state.getDomainByName("a")?.id).toBe(a.id);
    });

    test("renaming a domain to its own name stays a no-op rather than colliding with itself", () => {
      const state = createStateDb();
      const a = state.createDomain("a", "/srv/a");
      expect(state.renameDomain("a", "a")).toEqual(a);
    });
  });

  /**
   * #3210. `resolveDomainForPath` normalizes EVERY row inside its loop and throws on a
   * path that is not absolute — so one malformed row broke `which` for every query, while
   * `ls` kept working because it never normalizes. The writers were fixed by #3160; this
   * is the table refusing to hold the row at all.
   */
  describe("v9: the domains table enforces its own path shape (#3210)", () => {
    test("a local domain path that is not absolute cannot be written, even by raw SQL", () => {
      const state = createStateDb();
      expect(() => state.database.run("INSERT INTO domains (name, host, path) VALUES ('bad', NULL, 'rel/x')")).toThrow(
        /CHECK constraint failed/,
      );
      // ...and `which` still answers, which is the property the constraint is protecting.
      state.createDomain("phoenix", "/srv/phoenix");
      expect(state.resolveDomain("/srv/phoenix/packages/core")?.name).toBe("phoenix");
    });

    test("a host-bound path is exempt — it is that host's to interpret, not this one's", () => {
      const state = createStateDb();
      const remote = state.createDomain("remote", "~/work", "boxen0010");
      expect(remote.path).toBe("~/work");
    });

    test("upgrading a pre-v9 database keeps every row, the id high-water mark, and the index", () => {
      const p = tmpDbPath();
      paths.push(p);

      // Build the pre-v9 shape by hand: the same table WITHOUT the CHECK, carrying a row
      // that the constraint will reject. No writer can produce that row today — the point
      // is that the one database which has one still boots.
      const before = new StateDb(p);
      before.createDomain("a", "/srv/a");
      before.createDomain("b", "/srv/b");
      const raw = before.database;
      raw.exec(`
        CREATE TABLE domains_pre9 (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          host       TEXT,
          path       TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO domains_pre9 (id, name, host, path, created_at)
          SELECT id, name, host, path, created_at FROM domains;
        DROP TABLE domains;
        ALTER TABLE domains_pre9 RENAME TO domains;
        CREATE UNIQUE INDEX idx_domains_location ON domains(COALESCE(host, ''), path);
      `);
      raw.run("INSERT INTO domains (name, host, path) VALUES ('legacy', NULL, 'relative/x')");
      const legacyId = raw.query<{ id: number }, []>("SELECT id FROM domains WHERE name = 'legacy'").get()?.id;
      raw.run("UPDATE schema_versions SET version = 8 WHERE name = 'state'");
      before.close();

      const after = new StateDb(p);
      open.push(after);

      // Conforming rows survive with their ids, which is what every `domain_id` reference
      // in every partitioned table depends on.
      expect(after.listDomains().map((d) => [d.name, d.id])).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
      // The rejected row is quarantined, not deleted: a daemon that refuses to start is
      // the #3152 failure mode, and silently dropping the row is worse than the state it
      // came from.
      expect(
        after.database.query<{ name: string; path: string }, []>("SELECT name, path FROM domains_rejected").all(),
      ).toEqual([{ name: "legacy", path: "relative/x" }]);
      // The high-water mark, NOT max(id) of the copy: the quarantined row's id must never
      // be handed to a future domain, or that domain adopts whatever still references it.
      expect(after.createDomain("c", "/srv/c").id).toBe((legacyId ?? 0) + 1);
      // Both constraints came through the rebuild.
      expect(() => after.database.run("INSERT INTO domains (name, host, path) VALUES ('x', NULL, 'rel')")).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => after.createDomain("dup", "/srv/a")).toThrow(DomainConflictError);
      // The pragma was read before BEGIN and restored after COMMIT — never left flipped.
      expect(after.database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
    });
  });
});
