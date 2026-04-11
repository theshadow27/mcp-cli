/**
 * SQLite persistence for work items (sprint tracking).
 *
 * Standalone module — takes a bun:sqlite Database instance so it can share
 * the daemon's existing connection or be used independently in tests.
 */

import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

export type {
  WorkItemPhase,
  PrState,
  CiStatus,
  ReviewStatus,
  WorkItem,
} from "@mcp-cli/core";
import type { CiStatus, PrState, ReviewStatus, WorkItem, WorkItemPhase } from "@mcp-cli/core";

/** Snake-case row shape from SQLite. */
interface WorkItemRow {
  id: string;
  issue_number: number | null;
  branch: string | null;
  pr_number: number | null;
  pr_state: string;
  pr_url: string | null;
  ci_status: string;
  ci_run_id: number | null;
  ci_summary: string | null;
  review_status: string;
  phase: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    branch: row.branch,
    prNumber: row.pr_number,
    prState: row.pr_state as PrState,
    prUrl: row.pr_url,
    ciStatus: row.ci_status as CiStatus,
    ciRunId: row.ci_run_id,
    ciSummary: row.ci_summary,
    reviewStatus: row.review_status as ReviewStatus,
    phase: row.phase as WorkItemPhase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- DB class ----------

export class WorkItemDb {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  /**
   * Versioned migration using PRAGMA user_version.
   *
   * NOTE: user_version is database-wide. This works because WorkItemDb is
   * currently the only consumer. If StateDb (which shares this connection)
   * ever needs versioned migrations, switch to a per-table schema_versions table.
   */
  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_issue_number
          ON work_items(issue_number) WHERE issue_number IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_branch
          ON work_items(branch) WHERE branch IS NOT NULL;
        PRAGMA user_version = 1;
      `);
    }
    // Future: if (version < 2) { ALTER TABLE work_items ADD COLUMN ...; PRAGMA user_version = 2; }
  }

  createWorkItem(item: Partial<WorkItem>): WorkItem {
    const id = item.id ?? randomUUIDv7();
    this.db
      .query(
        `INSERT INTO work_items (id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, phase)
         VALUES ($id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $phase)`,
      )
      .run({
        $id: id,
        $issue_number: item.issueNumber ?? null,
        $branch: item.branch ?? null,
        $pr_number: item.prNumber ?? null,
        $pr_state: item.prState ?? "open",
        $pr_url: item.prUrl ?? null,
        $ci_status: item.ciStatus ?? "none",
        $ci_run_id: item.ciRunId ?? null,
        $ci_summary: item.ciSummary ?? null,
        $review_status: item.reviewStatus ?? "none",
        $phase: item.phase ?? "impl",
      });

    // We just inserted with this id, so the row must exist
    const created = this.getWorkItem(id);
    if (!created) throw new Error(`failed to read back work item: ${id}`);
    return created;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE id = ?").get(id);
    return row ? rowToWorkItem(row) : null;
  }

  updateWorkItem(id: string, patch: Partial<WorkItem>): WorkItem {
    const existing = this.getWorkItem(id);
    if (!existing) {
      throw new Error(`work item not found: ${id}`);
    }

    const fields: string[] = [];
    const values: Record<string, unknown> = { $id: id };

    const mappings: Array<[keyof WorkItem, string]> = [
      ["issueNumber", "issue_number"],
      ["branch", "branch"],
      ["prNumber", "pr_number"],
      ["prState", "pr_state"],
      ["prUrl", "pr_url"],
      ["ciStatus", "ci_status"],
      ["ciRunId", "ci_run_id"],
      ["ciSummary", "ci_summary"],
      ["reviewStatus", "review_status"],
      ["phase", "phase"],
    ];

    for (const [key, col] of mappings) {
      if (key in patch) {
        fields.push(`${col} = $${col}`);
        values[`$${col}`] = patch[key] ?? null;
      }
    }

    if (fields.length === 0) {
      return existing;
    }

    // Always bump updated_at
    fields.push("updated_at = datetime('now')");

    this.db
      .prepare(`UPDATE work_items SET ${fields.join(", ")} WHERE id = $id`)
      .run(values as Record<string, string | number | null>);

    const updated = this.getWorkItem(id);
    if (!updated) throw new Error(`failed to read back work item: ${id}`);
    return updated;
  }

  deleteWorkItem(id: string): boolean {
    this.db.query("DELETE FROM work_items WHERE id = ?").run(id);
    return (this.db.query<{ c: number }, []>("SELECT changes() as c").get()?.c ?? 0) > 0;
  }

  listWorkItems(filter?: { phase?: string }): WorkItem[] {
    if (filter?.phase) {
      return this.db
        .query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE phase = ? ORDER BY created_at")
        .all(filter.phase)
        .map(rowToWorkItem);
    }
    return this.db.query<WorkItemRow, []>("SELECT * FROM work_items ORDER BY created_at").all().map(rowToWorkItem);
  }

  getWorkItemByPr(prNumber: number): WorkItem | null {
    const row = this.db.query<WorkItemRow, [number]>("SELECT * FROM work_items WHERE pr_number = ?").get(prNumber);
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemByIssue(issueNumber: number): WorkItem | null {
    const row = this.db
      .query<WorkItemRow, [number]>("SELECT * FROM work_items WHERE issue_number = ?")
      .get(issueNumber);
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemByBranch(branch: string): WorkItem | null {
    const row = this.db.query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE branch = ?").get(branch);
    return row ? rowToWorkItem(row) : null;
  }

  /**
   * Atomically create or update a work item.
   * Uses INSERT ... ON CONFLICT(id) DO UPDATE to avoid TOCTOU races.
   */
  upsertWorkItem(item: Partial<WorkItem> & { id: string }): WorkItem {
    this.db
      .query(
        `INSERT INTO work_items (id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, phase)
         VALUES ($id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $phase)
         ON CONFLICT(id) DO UPDATE SET
           issue_number  = COALESCE($issue_number, issue_number),
           branch        = COALESCE($branch, branch),
           pr_number     = COALESCE($pr_number, pr_number),
           pr_state      = COALESCE($pr_state, pr_state),
           pr_url        = COALESCE($pr_url, pr_url),
           ci_status     = COALESCE($ci_status, ci_status),
           ci_run_id     = COALESCE($ci_run_id, ci_run_id),
           ci_summary    = COALESCE($ci_summary, ci_summary),
           review_status = COALESCE($review_status, review_status),
           phase         = COALESCE($phase, phase),
           updated_at    = datetime('now')`,
      )
      .run({
        $id: item.id,
        $issue_number: item.issueNumber ?? null,
        $branch: item.branch ?? null,
        $pr_number: item.prNumber ?? null,
        $pr_state: item.prState ?? null,
        $pr_url: item.prUrl ?? null,
        $ci_status: item.ciStatus ?? null,
        $ci_run_id: item.ciRunId ?? null,
        $ci_summary: item.ciSummary ?? null,
        $review_status: item.reviewStatus ?? null,
        $phase: item.phase ?? null,
      });

    const result = this.getWorkItem(item.id);
    if (!result) throw new Error(`failed to read back work item: ${item.id}`);
    return result;
  }
}
