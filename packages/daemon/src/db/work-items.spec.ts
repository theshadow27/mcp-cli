import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleUpdateError, WorkItemDb } from "./work-items";

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-wi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      /* ignore */
    }
  }
}

describe("WorkItemDb", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  function createDb(): WorkItemDb {
    const p = tmpDb();
    paths.push(p);
    const db = new Database(p, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    return new WorkItemDb(db);
  }

  describe("createWorkItem", () => {
    test("creates with defaults", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 42 });

      expect(item.id).toBeTruthy();
      expect(item.issueNumber).toBe(42);
      expect(item.phase).toBe("impl");
      expect(item.prState).toBe("open");
      expect(item.ciStatus).toBe("none");
      expect(item.reviewStatus).toBe("none");
      expect(item.createdAt).toBeTruthy();
      expect(item.updatedAt).toBeTruthy();
    });

    test("creates with custom id", () => {
      const db = createDb();
      const item = db.createWorkItem({ id: "custom-id", issueNumber: 1 });
      expect(item.id).toBe("custom-id");
    });

    test("creates with all fields", () => {
      const db = createDb();
      const item = db.createWorkItem({
        issueNumber: 10,
        branch: "feat/test",
        prNumber: 100,
        prState: "draft",
        prUrl: "https://github.com/org/repo/pull/100",
        ciStatus: "running",
        ciRunId: 999,
        ciSummary: "2/5 passed",
        reviewStatus: "pending",
        phase: "review",
      });

      expect(item.issueNumber).toBe(10);
      expect(item.branch).toBe("feat/test");
      expect(item.prNumber).toBe(100);
      expect(item.prState).toBe("draft");
      expect(item.prUrl).toBe("https://github.com/org/repo/pull/100");
      expect(item.ciStatus).toBe("running");
      expect(item.ciRunId).toBe(999);
      expect(item.ciSummary).toBe("2/5 passed");
      expect(item.reviewStatus).toBe("pending");
      expect(item.phase).toBe("review");
    });

    test("rejects duplicate pr_number", () => {
      const db = createDb();
      db.createWorkItem({ prNumber: 50 });
      expect(() => db.createWorkItem({ prNumber: 50 })).toThrow();
    });
  });

  describe("getWorkItem", () => {
    test("returns null for missing id", () => {
      const db = createDb();
      expect(db.getWorkItem("nonexistent")).toBeNull();
    });

    test("returns created item", () => {
      const db = createDb();
      const created = db.createWorkItem({ issueNumber: 7 });
      const fetched = db.getWorkItem(created.id);
      expect(fetched).toEqual(created);
    });
  });

  describe("updateWorkItem", () => {
    test("updates a single field", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const updated = db.updateWorkItem(item.id, { phase: "review" });
      expect(updated.phase).toBe("review");
      expect(updated.issueNumber).toBe(1);
    });

    test("bumps updated_at", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const updated = db.updateWorkItem(item.id, { ciStatus: "passed" });
      // updated_at should be set (may or may not differ from createdAt within the same second)
      expect(updated.updatedAt).toBeTruthy();
    });

    test("updates multiple fields", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const updated = db.updateWorkItem(item.id, {
        prNumber: 200,
        prState: "merged",
        phase: "done",
        ciStatus: "passed",
        reviewStatus: "approved",
      });
      expect(updated.prNumber).toBe(200);
      expect(updated.prState).toBe("merged");
      expect(updated.phase).toBe("done");
      expect(updated.ciStatus).toBe("passed");
      expect(updated.reviewStatus).toBe("approved");
    });

    test("throws for nonexistent item", () => {
      const db = createDb();
      expect(() => db.updateWorkItem("nope", { phase: "done" })).toThrow("work item not found");
    });

    test("no-op patch returns existing item unchanged", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const same = db.updateWorkItem(item.id, {});
      expect(same).toEqual(item);
    });
  });

  describe("deleteWorkItem", () => {
    test("removes item and returns true", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      expect(db.deleteWorkItem(item.id)).toBe(true);
      expect(db.getWorkItem(item.id)).toBeNull();
    });

    test("returns false for missing id", () => {
      const db = createDb();
      expect(db.deleteWorkItem("missing")).toBe(false);
    });

    test("removes transition rows when work item is deleted", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      db.updateWorkItem(item.id, { phase: "review" });
      expect(db.listTransitions(item.id).length).toBeGreaterThan(0);
      db.deleteWorkItem(item.id);
      expect(db.listTransitions(item.id)).toHaveLength(0);
      const rawDb: Database = (db as unknown as { db: Database }).db;
      const row = rawDb.query("SELECT COUNT(*) as c FROM work_items WHERE id = ?").get(item.id) as { c: number } | null;
      expect(row?.c ?? 0).toBe(0);
    });
  });

  describe("listWorkItems", () => {
    test("returns all items ordered by created_at", () => {
      const db = createDb();
      db.createWorkItem({ issueNumber: 1 });
      db.createWorkItem({ issueNumber: 2 });
      db.createWorkItem({ issueNumber: 3 });
      const items = db.listWorkItems();
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.issueNumber)).toEqual([1, 2, 3]);
    });

    test("filters by phase", () => {
      const db = createDb();
      db.createWorkItem({ issueNumber: 1, phase: "impl" });
      db.createWorkItem({ issueNumber: 2, phase: "review" });
      db.createWorkItem({ issueNumber: 3, phase: "impl" });

      const implItems = db.listWorkItems({ phase: "impl" });
      expect(implItems).toHaveLength(2);
      expect(implItems.map((i) => i.issueNumber)).toEqual([1, 3]);

      const reviewItems = db.listWorkItems({ phase: "review" });
      expect(reviewItems).toHaveLength(1);
      expect(reviewItems[0].issueNumber).toBe(2);
    });

    test("returns empty array when no items", () => {
      const db = createDb();
      expect(db.listWorkItems()).toEqual([]);
    });
  });

  describe("getWorkItemByPr", () => {
    test("finds by PR number", () => {
      const db = createDb();
      db.createWorkItem({ issueNumber: 1, prNumber: 101 });
      db.createWorkItem({ issueNumber: 2, prNumber: 102 });

      const item = db.getWorkItemByPr(101);
      expect(item).not.toBeNull();
      expect(item?.issueNumber).toBe(1);
    });

    test("returns null for unknown PR", () => {
      const db = createDb();
      expect(db.getWorkItemByPr(999)).toBeNull();
    });
  });

  describe("getWorkItemByIssue", () => {
    test("finds by issue number", () => {
      const db = createDb();
      db.createWorkItem({ issueNumber: 42, branch: "feat/42" });
      const item = db.getWorkItemByIssue(42);
      expect(item).not.toBeNull();
      expect(item?.branch).toBe("feat/42");
    });

    test("returns null for unknown issue", () => {
      const db = createDb();
      expect(db.getWorkItemByIssue(999)).toBeNull();
    });
  });

  describe("getWorkItemByBranch", () => {
    test("finds by branch name", () => {
      const db = createDb();
      db.createWorkItem({ branch: "feat/my-feature", issueNumber: 10 });
      const item = db.getWorkItemByBranch("feat/my-feature");
      expect(item).not.toBeNull();
      expect(item?.issueNumber).toBe(10);
    });

    test("returns null for unknown branch", () => {
      const db = createDb();
      expect(db.getWorkItemByBranch("nonexistent")).toBeNull();
    });
  });

  describe("upsertWorkItem", () => {
    test("creates a new item", () => {
      const db = createDb();
      const item = db.upsertWorkItem({ id: "pr:100", prNumber: 100, phase: "impl" });
      expect(item.id).toBe("pr:100");
      expect(item.prNumber).toBe(100);
      expect(item.phase).toBe("impl");
    });

    test("updates existing item on conflict", () => {
      const db = createDb();
      db.upsertWorkItem({ id: "pr:100", prNumber: 100, phase: "impl" });
      const updated = db.upsertWorkItem({ id: "pr:100", prNumber: 100, branch: "feat/x", phase: "review" });
      expect(updated.id).toBe("pr:100");
      expect(updated.branch).toBe("feat/x");
      expect(updated.phase).toBe("review");
    });

    test("preserves existing fields when upsert supplies null", () => {
      const db = createDb();
      db.upsertWorkItem({ id: "pr:100", prNumber: 100, branch: "feat/x" });
      const updated = db.upsertWorkItem({ id: "pr:100" });
      expect(updated.branch).toBe("feat/x");
      expect(updated.prNumber).toBe(100);
    });

    test("mergeStateStatus: explicit null clears existing value", () => {
      const db = createDb();
      db.upsertWorkItem({ id: "pr:200", prNumber: 200, mergeStateStatus: "BLOCKED" });
      const before = db.getWorkItem("pr:200");
      expect(before?.mergeStateStatus).toBe("BLOCKED");

      const cleared = db.upsertWorkItem({ id: "pr:200", mergeStateStatus: null });
      expect(cleared.mergeStateStatus).toBeNull();
    });

    test("mergeStateStatus: absent key preserves existing value", () => {
      const db = createDb();
      db.upsertWorkItem({ id: "pr:201", prNumber: 201, mergeStateStatus: "BLOCKED" });

      // upsert without mergeStateStatus key at all — should keep "BLOCKED"
      const kept = db.upsertWorkItem({ id: "pr:201" });
      expect(kept.mergeStateStatus).toBe("BLOCKED");
    });

    test("mergeStateStatus: round-trips a value through successive upserts", () => {
      const db = createDb();
      db.upsertWorkItem({ id: "pr:202", prNumber: 202 });
      db.upsertWorkItem({ id: "pr:202", mergeStateStatus: "CLEAN" });
      expect(db.getWorkItem("pr:202")?.mergeStateStatus).toBe("CLEAN");

      db.upsertWorkItem({ id: "pr:202", mergeStateStatus: null });
      expect(db.getWorkItem("pr:202")?.mergeStateStatus).toBeNull();
    });
  });

  describe("unique constraints", () => {
    test("rejects duplicate issue_number", () => {
      const db = createDb();
      db.createWorkItem({ id: "a", issueNumber: 42 });
      expect(() => db.createWorkItem({ id: "b", issueNumber: 42 })).toThrow();
    });

    test("rejects duplicate branch", () => {
      const db = createDb();
      db.createWorkItem({ id: "a", branch: "feat/x" });
      expect(() => db.createWorkItem({ id: "b", branch: "feat/x" })).toThrow();
    });

    test("allows multiple null issue_numbers", () => {
      const db = createDb();
      db.createWorkItem({ id: "a" });
      expect(() => db.createWorkItem({ id: "b" })).not.toThrow();
    });
  });

  describe("migration idempotency", () => {
    test("calling constructor twice on same db does not error", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      // Second call should be fine (CREATE TABLE IF NOT EXISTS)
      expect(() => new WorkItemDb(raw)).not.toThrow();
    });

    test("records version in schema_versions on fresh database", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      const row = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items");
      expect(row?.version).toBe(6);
    });

    test("does not touch PRAGMA user_version (leaves it free for other consumers)", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      const version = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      expect(version).toBe(0);
    });

    test("skips migration when schema_versions already current", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      // Second construction should be a no-op regardless of schema_versions state
      expect(() => new WorkItemDb(raw)).not.toThrow();
      const row = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items");
      expect(row?.version).toBe(6);
    });

    test("legacy v1 DB (work_items table, no transitions table) seeds at 1 then upgrades to 2", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");

      // Simulate a legacy v1 deployment: work_items table exists, no transitions table,
      // no schema_versions entry. (Matches what shipped before this migration fix.)
      raw.exec(`
        CREATE TABLE work_items (
          id              TEXT PRIMARY KEY,
          issue_number    INTEGER UNIQUE,
          branch          TEXT UNIQUE,
          pr_number       INTEGER UNIQUE,
          pr_state        TEXT DEFAULT 'open',
          pr_url          TEXT,
          ci_status       TEXT DEFAULT 'none',
          ci_run_id       INTEGER,
          ci_summary      TEXT,
          review_status   TEXT DEFAULT 'none',
          phase           TEXT DEFAULT 'impl',
          created_at      TEXT DEFAULT (datetime('now')),
          updated_at      TEXT DEFAULT (datetime('now'))
        );
      `);
      raw.exec("INSERT INTO work_items (id, issue_number) VALUES ('legacy-1', 99)");

      const db = new WorkItemDb(raw);
      const seeded = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items");
      expect(seeded?.version).toBe(6);

      // v2 transitions table now exists
      const hasTransitions = raw
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='work_item_transitions'",
        )
        .get()?.n;
      expect(hasTransitions).toBe(1);

      // Pre-existing data preserved
      const item = db.getWorkItemByIssue(99);
      expect(item?.id).toBe("legacy-1");
    });

    test("does not collide with a second consumer using PRAGMA user_version", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");

      // A hypothetical second consumer owns PRAGMA user_version and bumps it to 5
      raw.exec("PRAGMA user_version = 5");

      // WorkItemDb must NOT read PRAGMA to infer its own state and must NOT
      // write to PRAGMA. On a fresh DB (no work_items table), it should detect
      // legacy v0, run both migrations, and leave PRAGMA at 5.
      const db = new WorkItemDb(raw);
      const userVersion = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      expect(userVersion).toBe(5);

      const row = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items");
      expect(row?.version).toBe(6);

      // And the tables actually got created (regression for the PRAGMA-fallback bug)
      const item = db.createWorkItem({ issueNumber: 1, phase: "impl" });
      expect(item.id).toBeDefined();
    });
  });

  describe("ci_run_states", () => {
    test("loadCiRunStates returns empty map on fresh DB", () => {
      const db = createDb();
      const states = db.loadCiRunStates();
      expect(states.size).toBe(0);
    });

    test("upsertCiRunState inserts and loadCiRunStates retrieves", () => {
      const db = createDb();
      db.upsertCiRunState(42, { suiteId: 1000, startedAt: 99999, emittedStarted: true, emittedFinished: false });
      const states = db.loadCiRunStates();
      expect(states.size).toBe(1);
      const state = states.get(42);
      expect(state).toEqual({ suiteId: 1000, startedAt: 99999, emittedStarted: true, emittedFinished: false });
    });

    test("upsertCiRunState overwrites on conflict", () => {
      const db = createDb();
      db.upsertCiRunState(42, { suiteId: 1000, startedAt: 10000, emittedStarted: true, emittedFinished: false });
      db.upsertCiRunState(42, { suiteId: 2000, startedAt: 20000, emittedStarted: true, emittedFinished: true });
      const states = db.loadCiRunStates();
      expect(states.size).toBe(1);
      expect(states.get(42)).toEqual({ suiteId: 2000, startedAt: 20000, emittedStarted: true, emittedFinished: true });
    });

    test("deleteCiRunState removes a row", () => {
      const db = createDb();
      db.upsertCiRunState(42, { suiteId: 1000, startedAt: 10000, emittedStarted: true, emittedFinished: false });
      db.upsertCiRunState(43, { suiteId: 1001, startedAt: 10001, emittedStarted: false, emittedFinished: false });
      db.deleteCiRunState(42);
      const states = db.loadCiRunStates();
      expect(states.size).toBe(1);
      expect(states.has(42)).toBe(false);
      expect(states.has(43)).toBe(true);
    });

    test("deleteCiRunState is a no-op for missing PR", () => {
      const db = createDb();
      expect(() => db.deleteCiRunState(999)).not.toThrow();
    });

    test("deleteWorkItem cascade-deletes associated ci_run_states", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1, phase: "impl" });
      db.updateWorkItem(item.id, { prNumber: 42 });
      db.upsertCiRunState(42, { suiteId: 1000, startedAt: 10000, emittedStarted: true, emittedFinished: false });
      db.upsertCiRunState(43, { suiteId: 1001, startedAt: 10001, emittedStarted: false, emittedFinished: false });
      db.deleteWorkItem(item.id);
      const states = db.loadCiRunStates();
      expect(states.has(42)).toBe(false);
      expect(states.has(43)).toBe(true);
    });

    test("boolean fields round-trip correctly", () => {
      const db = createDb();
      db.upsertCiRunState(1, { suiteId: 100, startedAt: 5000, emittedStarted: false, emittedFinished: false });
      db.upsertCiRunState(2, { suiteId: 200, startedAt: 6000, emittedStarted: true, emittedFinished: true });
      const states = db.loadCiRunStates();
      expect(states.get(1)?.emittedStarted).toBe(false);
      expect(states.get(1)?.emittedFinished).toBe(false);
      expect(states.get(2)?.emittedStarted).toBe(true);
      expect(states.get(2)?.emittedFinished).toBe(true);
    });
  });

  describe("transitions", () => {
    test("createWorkItem records an initial transition (from_phase=null)", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 7, phase: "impl" });
      const log = db.listTransitions(item.id);
      expect(log).toHaveLength(1);
      expect(log[0].fromPhase).toBeNull();
      expect(log[0].toPhase).toBe("impl");
      expect(log[0].forced).toBe(false);
    });

    test("updateWorkItem logs a phase transition when phase changes", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 8 });
      db.updateWorkItem(item.id, { phase: "review" });
      const log = db.listTransitions(item.id);
      expect(log).toHaveLength(2);
      expect(log[1].fromPhase).toBe("impl");
      expect(log[1].toPhase).toBe("review");
      expect(log[1].forced).toBe(false);
    });

    test("updateWorkItem without phase change does not append transition", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 9 });
      db.updateWorkItem(item.id, { prUrl: "https://example/pr/1" });
      expect(db.listTransitions(item.id)).toHaveLength(1);
    });

    test("forced transitions record forced=true with reason", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 10 });
      db.updateWorkItem(item.id, { phase: "done" }, { forced: true, forceReason: "abandoned" });
      const log = db.listTransitions(item.id);
      expect(log[1].forced).toBe(true);
      expect(log[1].forceReason).toBe("abandoned");
    });
  });

  describe("version tracking", () => {
    test("createWorkItem starts at version 1", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      expect(item.version).toBe(1);
    });

    test("updateWorkItem increments version", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const v2 = db.updateWorkItem(item.id, { ciStatus: "running" });
      expect(v2.version).toBe(2);
      const v3 = db.updateWorkItem(item.id, { ciStatus: "passed" });
      expect(v3.version).toBe(3);
    });

    test("no-op patch does not increment version", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const same = db.updateWorkItem(item.id, {});
      expect(same.version).toBe(1);
    });

    test("expectedVersion match succeeds", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      const updated = db.updateWorkItem(item.id, { ciStatus: "running" }, { expectedVersion: 1 });
      expect(updated.version).toBe(2);
    });

    test("expectedVersion mismatch throws StaleUpdateError", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      db.updateWorkItem(item.id, { ciStatus: "running" });
      expect(() => db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 1 })).toThrow(
        StaleUpdateError,
      );
    });

    test("StaleUpdateError carries item id and expected version", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      db.updateWorkItem(item.id, { ciStatus: "running" });
      try {
        db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 1 });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(StaleUpdateError);
        const err = e as StaleUpdateError;
        expect(err.workItemId).toBe(item.id);
        expect(err.expectedVersion).toBe(1);
      }
    });

    test("upsertWorkItem increments version on conflict", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      expect(item.version).toBe(1);
      db.upsertWorkItem({ id: item.id, ciStatus: "running" });
      const afterUpsert = db.getWorkItem(item.id);
      expect(afterUpsert?.version).toBe(2);
    });

    test("expectedVersion respects version bumped by upsertWorkItem", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      db.upsertWorkItem({ id: item.id, ciStatus: "running" });
      // version is now 2; expectedVersion: 1 should reject
      expect(() => db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 1 })).toThrow(
        StaleUpdateError,
      );
      // expectedVersion: 2 should succeed
      const updated = db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 2 });
      expect(updated.version).toBe(3);
    });

    test("setBranchIfNull increments version", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      expect(item.version).toBe(1);
      db.setBranchIfNull(item.id, "feat/branch");
      const after = db.getWorkItem(item.id);
      expect(after?.version).toBe(2);
      expect(after?.branch).toBe("feat/branch");
    });

    test("expectedVersion respects version bumped by setBranchIfNull", () => {
      const db = createDb();
      const item = db.createWorkItem({ issueNumber: 1 });
      db.setBranchIfNull(item.id, "feat/branch");
      // version is now 2; expectedVersion: 1 should reject
      expect(() => db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 1 })).toThrow(
        StaleUpdateError,
      );
      // expectedVersion: 2 should succeed
      const updated = db.updateWorkItem(item.id, { ciStatus: "passed" }, { expectedVersion: 2 });
      expect(updated.version).toBe(3);
    });
  });

  describe("concurrent update stress test", () => {
    test("N=20 sequential writers produce no lost updates", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      const db = new WorkItemDb(raw);

      const item = db.createWorkItem({ issueNumber: 1, phase: "impl" });
      const N = 20;

      for (let i = 0; i < N; i++) {
        db.updateWorkItem(item.id, { ciSummary: `writer-${i}` });
      }

      const final = db.getWorkItem(item.id);
      expect(final).not.toBeNull();
      expect(final?.version).toBe(N + 1);
      expect(final?.ciSummary).toBe(`writer-${N - 1}`);
    });

    test("N=20 sequential writes via separate connections produce no lost updates", () => {
      const p = tmpDb();
      paths.push(p);

      const setup = new Database(p, { create: true });
      setup.exec("PRAGMA journal_mode = WAL");
      const setupDb = new WorkItemDb(setup);
      const item = setupDb.createWorkItem({ issueNumber: 1, phase: "impl" });
      const itemId = item.id;
      setup.close();

      const N = 20;
      const results: boolean[] = [];

      for (let i = 0; i < N; i++) {
        const conn = new Database(p);
        conn.exec("PRAGMA busy_timeout = 5000");
        const wi = new WorkItemDb(conn);
        try {
          wi.updateWorkItem(itemId, { ciSummary: `conn-${i}` });
          results.push(true);
        } catch {
          results.push(false);
        } finally {
          conn.close();
        }
      }

      expect(results.every(Boolean)).toBe(true);

      const verify = new Database(p);
      const verifyDb = new WorkItemDb(verify);
      const final = verifyDb.getWorkItem(itemId);
      expect(final).not.toBeNull();
      expect(final?.version).toBe(N + 1);

      const transitions = verifyDb.listTransitions(itemId);
      expect(transitions).toHaveLength(1);
      verify.close();
    });

    test("N=20 sequential phase updates via separate connections produce correct transition log", () => {
      const p = tmpDb();
      paths.push(p);

      const setup = new Database(p, { create: true });
      setup.exec("PRAGMA journal_mode = WAL");
      const setupDb = new WorkItemDb(setup);
      const item = setupDb.createWorkItem({ issueNumber: 1, phase: "impl" });
      const itemId = item.id;
      setup.close();

      const phases = ["review", "qa", "done"] as const;
      const N = 20;
      let successes = 0;

      for (let i = 0; i < N; i++) {
        const conn = new Database(p);
        conn.exec("PRAGMA busy_timeout = 5000");
        const wi = new WorkItemDb(conn);
        const phase = phases[i % phases.length];
        wi.updateWorkItem(itemId, { phase }, { forced: true, forceReason: `writer-${i}` });
        successes++;
        conn.close();
      }

      expect(successes).toBe(N);

      const verify = new Database(p);
      const verifyDb = new WorkItemDb(verify);
      const final = verifyDb.getWorkItem(itemId);
      expect(final).not.toBeNull();
      expect(final?.version).toBe(N + 1);

      const transitions = verifyDb.listTransitions(itemId);
      expect(transitions.length).toBeGreaterThanOrEqual(N);

      for (let i = 1; i < transitions.length; i++) {
        expect(transitions[i].fromPhase).toBe(transitions[i - 1].toPhase);
      }
      verify.close();
    });
  });

  describe("schema_versions idempotency (#1890 #1891)", () => {
    test("schema_versions row exists after fresh migration", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      const row = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items");
      expect(row).toBeDefined();
      expect(row?.version).toBeGreaterThanOrEqual(0);
      raw.close();
    });

    test("INSERT OR IGNORE: constructor does not crash when schema_versions row is pre-seeded (concurrent race simulation)", () => {
      const p = tmpDb();
      paths.push(p);
      // Simulate the winner process: seed schema_versions before WorkItemDb opens.
      const seed = new Database(p, { create: true });
      seed.exec("PRAGMA journal_mode = WAL");
      seed.exec("CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
      seed.exec("INSERT INTO schema_versions (name, version) VALUES ('work_items', 6)");
      seed.close();
      // The second process (this WorkItemDb call) must not throw a UNIQUE constraint error.
      const db2 = new Database(p, { create: true });
      db2.exec("PRAGMA journal_mode = WAL");
      expect(() => new WorkItemDb(db2)).not.toThrow();
      db2.close();
    });

    test("setSchemaVersion UPSERT: version is at latest migration level after construction", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      const version = raw
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("work_items")?.version;
      expect(version).toBeGreaterThanOrEqual(1);
      raw.close();
    });
  });
});
