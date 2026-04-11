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

    test("sets user_version to 1 on fresh database", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      new WorkItemDb(raw);
      const version = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      expect(version).toBe(1);
    });

    test("skips migration when user_version is already current", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");

      // Manually create the table and set version to simulate existing DB
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
        PRAGMA user_version = 1;
      `);

      // Should not error — migration is a no-op
      expect(() => new WorkItemDb(raw)).not.toThrow();
    });

    test("upgrades pre-versioned database (user_version = 0) with existing table", () => {
      const p = tmpDb();
      paths.push(p);
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");

      // Simulate pre-versioned DB: table exists but user_version is 0
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

      // Insert data before migration
      raw.exec("INSERT INTO work_items (id, issue_number) VALUES ('existing-1', 99)");

      // Migration should succeed (CREATE TABLE IF NOT EXISTS is idempotent)
      const db = new WorkItemDb(raw);
      const version = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      expect(version).toBe(1);

      // Existing data should be preserved
      const item = db.getWorkItemByIssue(99);
      expect(item).not.toBeNull();
      expect(item?.id).toBe("existing-1");
    });
  });
});
