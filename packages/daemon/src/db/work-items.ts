/**
 * SQLite persistence for work items (sprint tracking).
 *
 * Standalone module — takes a bun:sqlite Database instance so it can share
 * the daemon's existing connection or be used independently in tests.
 */

import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

import type {
  CiStatus,
  MergeStateStatus,
  PrState,
  ReviewStatus,
  WorkItem,
  WorkItemPatch,
  WorkItemPhase,
} from "@mcp-cli/core";
import type { CiRunState } from "../github/ci-events";

/** A phase transition record from the append-only transition log. */
export interface WorkItemTransition {
  id: number;
  workItemId: string;
  fromPhase: string | null;
  toPhase: string;
  forced: boolean;
  forceReason: string | null;
  at: number;
}

interface WorkItemTransitionRow {
  id: number;
  work_item_id: string;
  from_phase: string | null;
  to_phase: string;
  forced: number;
  force_reason: string | null;
  at: number;
}

function rowToTransition(row: WorkItemTransitionRow): WorkItemTransition {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    fromPhase: row.from_phase,
    toPhase: row.to_phase,
    forced: row.forced !== 0,
    forceReason: row.force_reason,
    at: row.at,
  };
}

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
  merge_state_status: string | null;
  phase: string;
  created_at: string;
  updated_at: string;
  last_seen_head_oid: string | null;
  version: number;
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
    mergeStateStatus: (row.merge_state_status as MergeStateStatus) ?? null,
    phase: row.phase as WorkItemPhase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** Thrown when updateWorkItem detects a concurrent modification (version mismatch). */
export class StaleUpdateError extends Error {
  readonly expectedVersion: number;
  readonly workItemId: string;

  constructor(id: string, expectedVersion: number) {
    super(`stale update: work item ${id} was modified concurrently (expected version ${expectedVersion})`);
    this.name = "StaleUpdateError";
    this.workItemId = id;
    this.expectedVersion = expectedVersion;
  }
}

// Sentinel string used in upsertWorkItem to distinguish "explicitly set to null"
// from "field not provided" (which should leave the column unchanged via COALESCE).
const NULL_SENTINEL = "__NULL__";

// ---------- DB class ----------

export class WorkItemDb {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  /**
   * Per-consumer versioned migration using a shared `schema_versions(name, version)` table.
   *
   * Why not PRAGMA user_version: it's database-wide. StateDb and WorkItemDb share
   * the same SQLite connection, so a second consumer adding its own v2 migration
   * would read user_version=2 already and silently skip. schema_versions keys by
   * consumer name, so each migrates independently.
   *
   * Legacy handling: pre-existing deployments set PRAGMA user_version to 1 or 2.
   * On first boot after this change, we read PRAGMA as a fallback seed for the
   * work_items row in schema_versions, then never touch PRAGMA again (leaving it
   * at whatever value it had — harmless since no future code reads it).
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        name    TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);

    const CONSUMER = "work_items";
    let version = this.db
      .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
      .get(CONSUMER)?.version;

    if (version === undefined) {
      // No schema_versions row yet. Detect legacy state via table presence —
      // NOT via PRAGMA user_version (another consumer on the same connection
      // may have set it for their own purposes; that value means nothing to us).
      const hasWorkItems =
        this.db
          .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='work_items'")
          .get()?.n ?? 0;
      const hasTransitions =
        this.db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='work_item_transitions'",
          )
          .get()?.n ?? 0;

      if (hasTransitions > 0) {
        version = 2;
      } else if (hasWorkItems > 0) {
        version = 1;
      } else {
        version = 0;
      }
      this.db
        .query<void, [string, number]>("INSERT INTO schema_versions (name, version) VALUES (?, ?)")
        .run(CONSUMER, version);
    }

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
      `);
      this.setSchemaVersion(CONSUMER, 1);
      version = 1;
    }
    if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS work_item_transitions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id TEXT NOT NULL,
          from_phase TEXT,
          to_phase TEXT NOT NULL,
          forced INTEGER NOT NULL DEFAULT 0,
          force_reason TEXT,
          at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_work_item_transitions_item
          ON work_item_transitions(work_item_id);
      `);
      this.setSchemaVersion(CONSUMER, 2);
      version = 2;
    }
    if (version < 3) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN last_seen_head_oid TEXT");
      this.setSchemaVersion(CONSUMER, 3);
      version = 3;
    }
    if (version < 4) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN merge_state_status TEXT");
      this.setSchemaVersion(CONSUMER, 4);
      version = 4;
    }
    if (version < 5) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ci_run_states (
          pr_number        INTEGER PRIMARY KEY,
          suite_id         INTEGER NOT NULL,
          started_at       INTEGER NOT NULL,
          emitted_started  INTEGER NOT NULL DEFAULT 0,
          emitted_finished INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.setSchemaVersion(CONSUMER, 5);
      version = 5;
    }
    if (version < 6) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
        this.setSchemaVersion(CONSUMER, 6);
      })();
      version = 6;
    }
  }

  private setSchemaVersion(name: string, version: number): void {
    this.db.query<void, [number, string]>("UPDATE schema_versions SET version = ? WHERE name = ?").run(version, name);
  }

  createWorkItem(item: Partial<WorkItem>): WorkItem {
    const id = item.id ?? randomUUIDv7();
    this.db
      .query(
        `INSERT INTO work_items (id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, merge_state_status, phase)
         VALUES ($id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $merge_state_status, $phase)`,
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
        $merge_state_status: item.mergeStateStatus ?? null,
        $phase: item.phase ?? "impl",
      });

    // We just inserted with this id, so the row must exist
    const created = this.getWorkItem(id);
    if (!created) throw new Error(`failed to read back work item: ${id}`);
    this.recordTransition(id, null, created.phase, false);
    return created;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE id = ?").get(id);
    return row ? rowToWorkItem(row) : null;
  }

  /**
   * Atomically set `branch` only when it is currently NULL. Returns true if
   * the row was updated, false if the row is missing or already has a branch.
   *
   * Closes the TOCTOU window in the auto-populate flow (#1424 round 3): a
   * concurrent writer setting an explicit branch between a read and this
   * call cannot be clobbered because the WHERE clause filters on branch IS NULL.
   */
  setBranchIfNull(id: string, branch: string): boolean {
    const result = this.db
      .prepare("UPDATE work_items SET branch = $branch, updated_at = datetime('now') WHERE id = $id AND branch IS NULL")
      .run({ $id: id, $branch: branch });
    return result.changes > 0;
  }

  updateWorkItem(
    id: string,
    patch: WorkItemPatch,
    opts?: { forced?: boolean; forceReason?: string; expectedVersion?: number },
  ): WorkItem {
    return this.db
      .transaction(() => {
        const existing = this.getWorkItem(id);
        if (!existing) {
          throw new Error(`work item not found: ${id}`);
        }

        if (opts?.expectedVersion !== undefined && existing.version !== opts.expectedVersion) {
          throw new StaleUpdateError(id, opts.expectedVersion);
        }

        const fields: string[] = [];
        const values: Record<string, unknown> = { $id: id, $version: existing.version };

        const mappings: Array<[keyof WorkItemPatch, string]> = [
          ["issueNumber", "issue_number"],
          ["branch", "branch"],
          ["prNumber", "pr_number"],
          ["prState", "pr_state"],
          ["prUrl", "pr_url"],
          ["ciStatus", "ci_status"],
          ["ciRunId", "ci_run_id"],
          ["ciSummary", "ci_summary"],
          ["reviewStatus", "review_status"],
          ["mergeStateStatus", "merge_state_status"],
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

        fields.push("updated_at = datetime('now')");
        fields.push("version = version + 1");

        const result = this.db
          .prepare(`UPDATE work_items SET ${fields.join(", ")} WHERE id = $id AND version = $version`)
          .run(values as Record<string, string | number | null>);

        if (result.changes === 0) {
          throw new StaleUpdateError(id, existing.version);
        }

        if (patch.phase !== undefined && patch.phase !== existing.phase) {
          this.recordTransition(id, existing.phase, patch.phase, opts?.forced ?? false, opts?.forceReason);
        }

        const updated = this.getWorkItem(id);
        if (!updated) throw new Error(`failed to read back work item: ${id}`);
        return updated;
      })
      .immediate();
  }

  recordTransition(
    workItemId: string,
    fromPhase: string | null,
    toPhase: string,
    forced: boolean,
    forceReason?: string,
  ): void {
    this.db
      .query(
        `INSERT INTO work_item_transitions (work_item_id, from_phase, to_phase, forced, force_reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workItemId, fromPhase, toPhase, forced ? 1 : 0, forceReason ?? null);
  }

  listTransitions(workItemId: string): WorkItemTransition[] {
    return this.db
      .query<WorkItemTransitionRow, [string]>("SELECT * FROM work_item_transitions WHERE work_item_id = ? ORDER BY id")
      .all(workItemId)
      .map(rowToTransition);
  }

  deleteWorkItem(id: string): boolean {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ pr_number: number | null }, [string]>("SELECT pr_number FROM work_items WHERE id = ?")
        .get(id);
      if (row?.pr_number !== null && row?.pr_number !== undefined) {
        this.db.query("DELETE FROM ci_run_states WHERE pr_number = ?").run(row.pr_number);
      }
      this.db.query("DELETE FROM work_item_transitions WHERE work_item_id = ?").run(id);
      this.db.query("DELETE FROM work_items WHERE id = ?").run(id);
      return (this.db.query<{ c: number }, []>("SELECT changes() as c").get()?.c ?? 0) > 0;
    })();
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

  /** Get the last-seen HEAD commit OID for a PR, used by the push detector. Returns null if not yet seen. */
  getLastSeenHeadOid(prNumber: number): string | null {
    const row = this.db
      .query<{ last_seen_head_oid: string | null }, [number]>(
        "SELECT last_seen_head_oid FROM work_items WHERE pr_number = ?",
      )
      .get(prNumber);
    return row?.last_seen_head_oid ?? null;
  }

  /** Persist the HEAD commit OID for a PR so the push detector survives daemon restarts. */
  setLastSeenHeadOid(prNumber: number, oid: string): void {
    this.db.prepare("UPDATE work_items SET last_seen_head_oid = ? WHERE pr_number = ?").run(oid, prNumber);
  }

  // -- CI run states --

  loadCiRunStates(): Map<number, CiRunState> {
    const rows = this.db
      .query<
        { pr_number: number; suite_id: number; started_at: number; emitted_started: number; emitted_finished: number },
        []
      >("SELECT pr_number, suite_id, started_at, emitted_started, emitted_finished FROM ci_run_states")
      .all();
    const map = new Map<number, CiRunState>();
    for (const row of rows) {
      map.set(row.pr_number, {
        suiteId: row.suite_id,
        startedAt: row.started_at,
        emittedStarted: row.emitted_started !== 0,
        emittedFinished: row.emitted_finished !== 0,
      });
    }
    return map;
  }

  upsertCiRunState(prNumber: number, state: CiRunState): void {
    this.db
      .prepare(
        `INSERT INTO ci_run_states (pr_number, suite_id, started_at, emitted_started, emitted_finished)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           suite_id = excluded.suite_id,
           started_at = excluded.started_at,
           emitted_started = excluded.emitted_started,
           emitted_finished = excluded.emitted_finished`,
      )
      .run(prNumber, state.suiteId, state.startedAt, state.emittedStarted ? 1 : 0, state.emittedFinished ? 1 : 0);
  }

  deleteCiRunState(prNumber: number): void {
    this.db.prepare("DELETE FROM ci_run_states WHERE pr_number = ?").run(prNumber);
  }

  /**
   * Atomically create or update a work item.
   * Uses INSERT ... ON CONFLICT(id) DO UPDATE to avoid TOCTOU races.
   */
  upsertWorkItem(item: Partial<WorkItem> & { id: string }): WorkItem {
    const before = this.getWorkItem(item.id);
    this.db
      .query(
        `INSERT INTO work_items (id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, merge_state_status, phase)
         VALUES ($id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $merge_state_status, $phase)
         ON CONFLICT(id) DO UPDATE SET
           issue_number       = COALESCE($issue_number, issue_number),
           branch             = COALESCE($branch, branch),
           pr_number          = COALESCE($pr_number, pr_number),
           pr_state           = COALESCE($pr_state, pr_state),
           pr_url             = COALESCE($pr_url, pr_url),
           ci_status          = COALESCE($ci_status, ci_status),
           ci_run_id          = COALESCE($ci_run_id, ci_run_id),
           ci_summary         = COALESCE($ci_summary, ci_summary),
           review_status      = COALESCE($review_status, review_status),
           merge_state_status = CASE WHEN $merge_state_status = '__NULL__' THEN NULL ELSE COALESCE($merge_state_status, merge_state_status) END,
           phase              = COALESCE($phase, phase),
           version            = version + 1,
           updated_at         = datetime('now')`,
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
        $merge_state_status: "mergeStateStatus" in item ? (item.mergeStateStatus ?? NULL_SENTINEL) : null,
        $phase: item.phase ?? null,
      });

    const result = this.getWorkItem(item.id);
    if (!result) throw new Error(`failed to read back work item: ${item.id}`);
    // Only log when we have a phase to log. Upsert can insert a row without a
    // phase value (SQLite DEFAULT is bypassed by explicit NULL); in that case
    // the transition log stays empty until a phase is assigned.
    if (result.phase) {
      if (!before) {
        this.recordTransition(item.id, null, result.phase, false);
      } else if (before.phase !== result.phase) {
        this.recordTransition(item.id, before.phase, result.phase, false);
      }
    }
    return result;
  }
}
