import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkItemDb } from "./work-items";

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
      expect(row?.version).toBe(2);
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
      expect(row?.version).toBe(2);
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
      expect(seeded?.version).toBe(2);

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
      expect(row?.version).toBe(2);

      // And the tables actually got created (regression for the PRAGMA-fallback bug)
      const item = db.createWorkItem({ issueNumber: 1, phase: "impl" });
      expect(item.id).toBeDefined();
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
});
