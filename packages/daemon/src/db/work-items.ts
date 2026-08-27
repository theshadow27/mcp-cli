/**
 * SQLite persistence for work items (sprint tracking).
 *
 * Standalone module — takes a bun:sqlite Database instance so it can share
 * the daemon's existing connection or be used independently in tests.
 *
 * @domain-partitioned — see the `domain-scoped-queries` rule in `scripts/rules/`. Every
 * statement in this file that touches a table declared with a `domain_id` column must
 * constrain that column; the rule fails the build otherwise. The marker is what opts this
 * file in, so the check ratchets module-by-module as the #3019 epic migrates them.
 *
 * The shape enforces the same thing at the type level: `WorkItemDb` owns migration and
 * nothing else, and every read and write lives on {@link DomainWorkItems}, which can only
 * be obtained from {@link WorkItemDb.forDomain}. There is no unscoped query to forget to
 * scope — an invariant an orchestrator could rationalize past is a function, not prose
 * (`docs/domain-scoped-mcx.md`).
 */

// @domain-partitioned — enforced by scripts/rules/domain-scoped-queries.rule.ts. Keep this
// marker on a line comment: it is what opts the module into the check.

import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

import {
  type CiStatus,
  type MergeStateStatus,
  NO_DOMAIN_ID,
  type PrState,
  type ReviewStatus,
  type WorkItem,
  type WorkItemPatch,
  type WorkItemPhase,
  domainScopedWorkItemId,
  workItemIdCandidates,
} from "@mcp-cli/core";
import type { CiRunState } from "../github/ci-events";

/** A phase transition record from the append-only transition log. */
export interface WorkItemTransition {
  id: number;
  workItemId: string;
  /** Owning domain, copied from the work item at transition time. */
  domainId: number;
  fromPhase: string | null;
  toPhase: string;
  forced: boolean;
  forceReason: string | null;
  at: number;
}

interface WorkItemTransitionRow {
  id: number;
  work_item_id: string;
  domain_id: number;
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
    domainId: row.domain_id,
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
  domain_id: number;
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
  automation_overrides: string | null;
  phase: string;
  created_at: string;
  updated_at: string;
  last_seen_head_oid: string | null;
  version: number;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    domainId: row.domain_id,
    issueNumber: row.issue_number,
    branch: row.branch,
    prNumber: row.pr_number,
    // dotw-todo no-db-ipc-cast: unguarded pr_state restore cast — fix in #2742
    prState: row.pr_state as PrState,
    prUrl: row.pr_url,
    // dotw-todo no-db-ipc-cast: unguarded ci_status restore cast — fix in #2742
    ciStatus: row.ci_status as CiStatus,
    ciRunId: row.ci_run_id,
    ciSummary: row.ci_summary,
    // dotw-todo no-db-ipc-cast: unguarded review_status restore cast — fix in #2742
    reviewStatus: row.review_status as ReviewStatus,
    // dotw-todo no-db-ipc-cast: cast bypasses the ?? null fallback for non-null garbage — fix in #2742
    mergeStateStatus: (row.merge_state_status as MergeStateStatus) ?? null,
    // dotw-todo no-db-ipc-cast: unguarded phase restore cast (load-bearing for sprint pipeline) — fix in #2742
    phase: row.phase as WorkItemPhase,
    automationOverrides: row.automation_overrides ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** A per-domain unique key a work item can claim. */
export type WorkItemKeyField = "branch" | "prNumber" | "issueNumber";

/**
 * Thrown when a write would claim a unique key another row in the same domain already owns.
 *
 * Replaces the bare SQLite text (`UNIQUE constraint failed: work_items.domain_id,
 * work_items.branch`) that #3254 surfaced to an orchestrator mid-sprint: it named a column,
 * not the row in the way, and offered no route out — the operator invented a
 * `tombstone/dup-of-3066` branch rename to free the slot. Naming the blocking id and the
 * remedy is the whole point of this class.
 */
export class WorkItemConflictError extends Error {
  /** The row the caller was trying to write. */
  readonly workItemId: string;
  /** The row that already claims `value`. */
  readonly conflictingId: string;
  readonly field: WorkItemKeyField;
  readonly value: string | number;

  constructor(workItemId: string, conflictingId: string, field: WorkItemKeyField, value: string | number) {
    super(
      `cannot set ${field}=${JSON.stringify(value)} on ${workItemId}: work item ${conflictingId} in this domain already claims it. ` +
        `Clear it there first (work_items_update {"id":${JSON.stringify(conflictingId)},"${field}":null}) or remove that item ` +
        `(work_items_delete {"id":${JSON.stringify(conflictingId)}}).`,
    );
    this.name = "WorkItemConflictError";
    this.workItemId = workItemId;
    this.conflictingId = conflictingId;
    this.field = field;
    this.value = value;
  }
}

/**
 * The ids `mcx track` / `work_items_track` mint for a row whose only identity is `value`.
 *
 * Kept next to {@link DomainWorkItems.isAbsorbableShadow} rather than inlined at the two
 * mint sites, because the predicate has to recognise exactly what those sites produce —
 * a fourth spelling added there and not here silently turns a mergeable shadow into a
 * hard conflict.
 */
function shadowIdSpellings(field: WorkItemKeyField, value: string | number): string[] {
  switch (field) {
    case "branch":
      return [`branch:${value}`];
    case "prNumber":
      return [`pr:${value}`];
    case "issueNumber":
      return [`issue:${value}`, `#${value}`];
  }
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
        .query<void, [string, number]>("INSERT OR IGNORE INTO schema_versions (name, version) VALUES (?, ?)")
        .run(CONSUMER, version);
    }

    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS work_items (
            id              TEXT PRIMARY KEY,
            domain_id       INTEGER NOT NULL DEFAULT 0,
            issue_number    INTEGER,
            branch          TEXT,
            pr_number       INTEGER,
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
          -- Per-domain, not global (#3034). issue_number/branch/pr_number were globally
          -- unique, so two projects could not both have an issue #42. The column-level
          -- UNIQUE constraints are gone; these partial indexes replace them.
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_domain_issue
            ON work_items(domain_id, issue_number) WHERE issue_number IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_domain_branch
            ON work_items(domain_id, branch) WHERE branch IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_domain_pr
            ON work_items(domain_id, pr_number) WHERE pr_number IS NOT NULL;
        `);
        this.setSchemaVersion(CONSUMER, 1);
      })();
      version = 1;
    }
    if (version < 2) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS work_item_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain_id INTEGER NOT NULL DEFAULT 0,
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
      })();
      version = 2;
    }
    if (version < 3) {
      // Transactional, like the v<6 step three cases down. These were dead code for
      // existing installs; mcx.db is a brand-new file, so #3034 re-arms all of them for
      // 100% of users — and an interruption between the ALTER and the version bump
      // bricks the daemon permanently ("duplicate column name" on every later open).
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN last_seen_head_oid TEXT");
        this.setSchemaVersion(CONSUMER, 3);
      })();
      version = 3;
    }
    if (version < 4) {
      // Transactional, like the v<6 step three cases down. These were dead code for
      // existing installs; mcx.db is a brand-new file, so #3034 re-arms all of them for
      // 100% of users — and an interruption between the ALTER and the version bump
      // bricks the daemon permanently ("duplicate column name" on every later open).
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN merge_state_status TEXT");
        this.setSchemaVersion(CONSUMER, 4);
      })();
      version = 4;
    }
    if (version < 5) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ci_run_states (
            domain_id        INTEGER NOT NULL DEFAULT 0,
            pr_number        INTEGER NOT NULL,
            suite_id         INTEGER NOT NULL,
            started_at       INTEGER NOT NULL,
            emitted_started  INTEGER NOT NULL DEFAULT 0,
            emitted_finished INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (domain_id, pr_number)
          )
        `);
        this.setSchemaVersion(CONSUMER, 5);
      })();
      version = 5;
    }
    if (version < 6) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
        this.setSchemaVersion(CONSUMER, 6);
      })();
      version = 6;
    }
    if (version < 7) {
      // Transactional, like the v<6 step three cases down. These were dead code for
      // existing installs; mcx.db is a brand-new file, so #3034 re-arms all of them for
      // 100% of users — and an interruption between the ALTER and the version bump
      // bricks the daemon permanently ("duplicate column name" on every later open).
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN automation_overrides TEXT");
        this.setSchemaVersion(CONSUMER, 7);
      })();
      version = 7;
    }
  }

  private setSchemaVersion(name: string, version: number): void {
    this.db
      .query<void, [string, number]>(
        "INSERT INTO schema_versions (name, version) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version",
      )
      .run(name, version);
  }

  /**
   * The only way to read or write work items: a handle bound to one domain.
   *
   * Deliberately not "an optional `domainId` argument with a sensible default". A default
   * is a decision the caller never had to make, and #3034's audit found exactly that shape
   * failing silently — `WHERE pr_number = 42` returning an arbitrary domain's row. Here the
   * partition is the object, so a query with no domain filter is not something a reviewer
   * has to notice; it does not typecheck.
   *
   * Pass `NO_DOMAIN_ID` explicitly for rows that predate domain resolution — the sentinel
   * is a real partition with a real name, not an absence.
   */
  forDomain(domainId: number): DomainWorkItems {
    if (!Number.isInteger(domainId) || domainId < NO_DOMAIN_ID) {
      throw new Error(`invalid domain id ${String(domainId)}: expected a non-negative integer (0 = unassigned)`);
    }
    return new DomainWorkItems(this.db, domainId);
  }

  /**
   * How many work items sit in the unassigned partition.
   *
   * A **count of the sentinel partition only** — never a peer domain, and never row contents.
   * It exists to make one specific failure legible: rows written before domains existed are
   * imported at `domain_id = 0`, while `importScopesAsDomains` auto-creates a domain per
   * `~/.mcp-cli/scopes/*.json` sidecar on daemon boot. A user standing in their own project
   * therefore queries domain N, their items are all in partition 0, and they get an empty
   * list with no explanation.
   *
   * The empty list is the honest answer for that domain; the silence is not. Callers use this
   * to say "0 here, but N unassigned" instead of just "0" — the same lesson this PR learned
   * when a startup-bound daemon reader reported no tracked items rather than an error.
   */
  countUnassignedWorkItems(): number {
    return (
      this.db
        .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM work_items WHERE domain_id = ?")
        .get(NO_DOMAIN_ID)?.n ?? 0
    );
  }

  /**
   * Unassigned rows worth reporting to `scoped`'s caller, or 0 when there is nothing to say.
   *
   * **The predicate lives here, once.** Both the IPC handler and the MCP tool need it, and
   * when they each expressed it themselves they made the same mistake: gating on the count of
   * the *filtered* list. A domain with 40 live items and a `phase=qa` filter matching none of
   * them would then be told its data was stranded — a false alarm in the one feature whose
   * job is to report real ones.
   *
   * "The domain holds nothing" means exactly that: no rows at all in this domain, whatever
   * the caller happened to filter for.
   */
  strandedUnassignedCount(scoped: DomainWorkItems): number {
    if (scoped.domainId === NO_DOMAIN_ID) return 0;
    if (scoped.countWorkItems() > 0) return 0;
    return this.countUnassignedWorkItems();
  }

  /**
   * **Ring 0: the daemon's own readers, which span every domain by design.**
   *
   * The pollers, derived-event rules, automation dispatcher and `ctx.workItem` resolution are
   * daemon-internal machinery, not a caller standing in a project. They must observe every
   * tracked item on the box, because there is no "the daemon's domain" to observe instead:
   * `mcpd` is auto-started by whichever `mcx` invocation happened to need it, sometimes with
   * no cwd at all, so any startup-time binding partitions the daemon by an accident of
   * process ancestry.
   *
   * Binding them at startup — which this PR briefly did — produces the worst available
   * failure: writers scope per request from the caller's cwd, readers sit in whatever
   * partition the daemon woke up in, and `listWorkItems()` returns `[]`. No PR state, no CI
   * events, no automation, for every tracked item, reported as an empty list rather than an
   * error.
   *
   * **This is a deliberate cross-domain read, not a forgotten `WHERE`.** That distinction is
   * the entire reason this lives behind a named method instead of a bare query: an unscoped
   * read that merely *looks* unscoped is exactly what the next scoping sweep will "fix" back
   * into the bug above. Every statement here also carries a `dotw-ignore` naming the reason,
   * so the rule that enforces partitioning cannot be silently satisfied by accident.
   *
   * Reads are cross-domain; **writes are not**. Every row carries its `domainId`, so a caller
   * dispatches through {@link CrossDomainWorkItems.forRow} and writes inside the partition the
   * row actually belongs to.
   */
  acrossDomains(): CrossDomainWorkItems {
    return new CrossDomainWorkItems(this.db, this);
  }
}

/**
 * Ring-0 reads over every domain. See {@link WorkItemDb.acrossDomains} for why this exists
 * and why it is named rather than implicit.
 *
 * Lookups by a per-domain unique key (`pr_number`, `branch`, `issue_number`) return an
 * **array**: two domains may each legitimately hold PR #7, and collapsing that to one row
 * would reintroduce the ambiguity #3034 removed. Callers that can only act on one must say
 * which, in the open.
 */
/**
 * Pick one row when a ring-0 lookup legitimately matched several domains.
 *
 * A PR/branch/issue number is unique **per domain**, so a cross-domain lookup can return
 * more than one row. Callers whose interface is single-valued take the first — but say so,
 * because a silently-chosen row is the ambiguity #3034 removed from the schema creeping back
 * in at the consumer. A domain-scoped handle ({@link WorkItemDb.forDomain}) never needs this:
 * inside one partition the key is unique, which is why per-project dispatch (#3192) removes
 * the choice rather than making it better.
 */
export function firstOf<T extends { domainId: number }>(
  matches: T[],
  label: string,
  warn: (msg: string) => void,
): T | null {
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    warn(
      `[mcpd] ${label} matches ${matches.length} work items across domains (${matches
        .map((m) => m.domainId)
        .join(", ")}); acting on domain ${matches[0].domainId}.`,
    );
  }
  return matches[0];
}

export class CrossDomainWorkItems {
  private db: Database;
  private owner: WorkItemDb;

  constructor(db: Database, owner: WorkItemDb) {
    this.db = db;
    this.owner = owner;
  }

  /** The scoped handle for a row this view returned — how a ring-0 reader writes. */
  forRow(item: Pick<WorkItem, "domainId">): DomainWorkItems {
    return this.owner.forDomain(item.domainId);
  }

  /** Every tracked item on the box, in every domain. */
  listWorkItems(filter?: { phase?: string; excludeArchived?: boolean }): WorkItem[] {
    const archiveClause = filter?.excludeArchived
      ? " AND NOT (phase = 'done' AND datetime(updated_at) < datetime('now', '-7 days'))"
      : "";
    if (filter?.phase) {
      return (
        this.db
          // dotw-ignore domain-scoped-queries: ring 0 — daemon-internal readers span every domain by design (see WorkItemDb.acrossDomains)
          .query<WorkItemRow, [string]>(`SELECT * FROM work_items WHERE phase = ?${archiveClause} ORDER BY created_at`)
          .all(filter.phase)
          .map(rowToWorkItem)
      );
    }
    return (
      this.db
        // dotw-ignore domain-scoped-queries: ring 0 — daemon-internal readers span every domain by design (see WorkItemDb.acrossDomains)
        .query<WorkItemRow, []>(`SELECT * FROM work_items WHERE 1 = 1${archiveClause} ORDER BY created_at`)
        .all()
        .map(rowToWorkItem)
    );
  }

  /** By global primary key. Unambiguous: `id` is unique across the whole table. */
  getWorkItem(id: string): WorkItem | null {
    const row = this.db
      // dotw-ignore domain-scoped-queries: ring 0 — id is the global primary key (see WorkItemDb.acrossDomains)
      .query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE id = ?")
      .get(id);
    return row ? rowToWorkItem(row) : null;
  }

  /** Every domain's item for this PR number. May legitimately hold more than one. */
  findByPr(prNumber: number): WorkItem[] {
    return (
      this.db
        // dotw-ignore domain-scoped-queries: ring 0 — returns every domain's match, not an arbitrary one (see WorkItemDb.acrossDomains)
        .query<WorkItemRow, [number]>("SELECT * FROM work_items WHERE pr_number = ? ORDER BY domain_id")
        .all(prNumber)
        .map(rowToWorkItem)
    );
  }

  /** Every domain's item for this branch name. */
  findByBranch(branch: string): WorkItem[] {
    return (
      this.db
        // dotw-ignore domain-scoped-queries: ring 0 — returns every domain's match, not an arbitrary one (see WorkItemDb.acrossDomains)
        .query<WorkItemRow, [string]>("SELECT * FROM work_items WHERE branch = ? ORDER BY domain_id")
        .all(branch)
        .map(rowToWorkItem)
    );
  }

  /** Every domain's item for this issue number. */
  findByIssue(issueNumber: number): WorkItem[] {
    return (
      this.db
        // dotw-ignore domain-scoped-queries: ring 0 — returns every domain's match, not an arbitrary one (see WorkItemDb.acrossDomains)
        .query<WorkItemRow, [number]>("SELECT * FROM work_items WHERE issue_number = ? ORDER BY domain_id")
        .all(issueNumber)
        .map(rowToWorkItem)
    );
  }

  /**
   * CI run states for every domain, keyed by {@link ciRunStateKey}.
   *
   * The key is `domainId:prNumber`, not `prNumber`: a bare PR number collides the moment two
   * domains each have a PR #7, which is the case this whole epic exists to support.
   */
  loadCiRunStates(): Map<string, CiRunState> {
    type CiRunStateRow = {
      domain_id: number;
      pr_number: number;
      suite_id: number;
      started_at: number;
      emitted_started: number;
      emitted_finished: number;
    };
    const rows = this.db
      .query<CiRunStateRow, []>(
        // dotw-ignore domain-scoped-queries: ring 0 — daemon-internal readers span every domain by design (see WorkItemDb.acrossDomains)
        "SELECT domain_id, pr_number, suite_id, started_at, emitted_started, emitted_finished FROM ci_run_states",
      )
      .all();
    const map = new Map<string, CiRunState>();
    for (const row of rows) {
      map.set(ciRunStateKey(row.domain_id, row.pr_number), {
        suiteId: row.suite_id,
        startedAt: row.started_at,
        emittedStarted: row.emitted_started !== 0,
        emittedFinished: row.emitted_finished !== 0,
      });
    }
    return map;
  }

  /**
   * Count tracked work items not yet in the terminal "done" phase, across every domain
   * (#3234). The GitHub work-item poller does scheduled work for every one of these
   * regardless of domain, so this backs the idle-shutdown inhibitor in
   * packages/daemon/src/index.ts (resetIdleTimer) — a single daemon-lifetime concern,
   * not a per-domain one.
   */
  countActiveWorkItems(): number {
    return (
      this.db
        // dotw-ignore domain-scoped-queries: ring 0 — daemon-wide idle-shutdown check spans every domain by design (see WorkItemDb.acrossDomains)
        .query<{ n: number }, []>("SELECT COUNT(*) as n FROM work_items WHERE phase != 'done'")
        .get()?.n ?? 0
    );
  }
}

/** Composite key for a CI run state held across domains. See {@link CrossDomainWorkItems.loadCiRunStates}. */
export function ciRunStateKey(domainId: number, prNumber: number): string {
  return `${domainId}:${prNumber}`;
}

/** Inverse of {@link ciRunStateKey}. */
export function parseCiRunStateKey(key: string): { domainId: number; prNumber: number } {
  const [domainId, prNumber] = key.split(":");
  return { domainId: Number(domainId), prNumber: Number(prNumber) };
}

/**
 * Work-item reads and writes inside a single domain.
 *
 * Every statement below constrains `domain_id`, including lookups by primary key: work-item
 * ids are derived from the thing they track (`#42`, `pr:7`) and are therefore *guessable*,
 * so an id alone must not be able to reach across the partition.
 */
export class DomainWorkItems {
  private db: Database;
  /** The domain every statement on this handle is constrained to. */
  readonly domainId: number;

  constructor(db: Database, domainId: number) {
    this.db = db;
    this.domainId = domainId;
  }

  /**
   * Create a work item in this domain.
   *
   * `domainId` is absent from the accepted shape rather than ignored: the handle decides
   * the partition, and a caller cannot express a different one.
   */
  createWorkItem(item: Omit<Partial<WorkItem>, "domainId">): WorkItem {
    const id = domainScopedWorkItemId(this.domainId, item.id ?? randomUUIDv7());
    this.db
      .query(
        `INSERT INTO work_items (id, domain_id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, merge_state_status, automation_overrides, phase)
         VALUES ($id, $domain_id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $merge_state_status, $automation_overrides, $phase)`,
      )
      .run({
        $id: id,
        $domain_id: this.domainId,
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
        $automation_overrides: item.automationOverrides ?? null,
        $phase: item.phase ?? "impl",
      });

    // We just inserted with this id, so the row must exist
    const created = this.getWorkItem(id);
    if (!created) throw new Error(`failed to read back work item: ${id}`);
    this.recordTransition(id, null, created.phase, false);
    return created;
  }

  /**
   * Look up by primary key **within this domain**.
   *
   * The `domain_id` predicate is not redundant with the `id` primary key. Ids are derived
   * from the tracked object (`#42`, `pr:7`, `branch:fix/foo`), so any caller can guess the
   * id another domain would have minted; without the predicate, `work_items_get {id:"#42"}`
   * would read across the partition.
   *
   * Accepts either the stored id or its unscoped spelling — inside domain 3, `#42` and
   * `d3:#42` name the same row. Both candidates are filtered by `domain_id`.
   */
  getWorkItem(id: string): WorkItem | null {
    for (const candidate of workItemIdCandidates(this.domainId, id)) {
      const row = this.db
        .query<WorkItemRow, [number, string]>("SELECT * FROM work_items WHERE domain_id = ? AND id = ?")
        .get(this.domainId, candidate);
      if (row) return rowToWorkItem(row);
    }
    return null;
  }

  /**
   * Canonical stored id for `id` within this domain, or `null` when no such row exists here.
   *
   * Every id-taking write funnels through this, so a caller that names another domain's row
   * gets "not found" rather than a write that lands outside its partition.
   */
  private storedId(id: string): string | null {
    for (const candidate of workItemIdCandidates(this.domainId, id)) {
      const row = this.db
        .query<{ id: string }, [number, string]>("SELECT id FROM work_items WHERE domain_id = ? AND id = ?")
        .get(this.domainId, candidate);
      if (row) return row.id;
    }
    return null;
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
      .prepare(
        "UPDATE work_items SET branch = $branch, version = version + 1, updated_at = datetime('now') WHERE domain_id = $domain_id AND id = $id AND branch IS NULL",
      )
      .run({ $domain_id: this.domainId, $id: this.storedId(id) ?? id, $branch: branch });
    return result.changes > 0;
  }

  /** How many transitions this row has logged. One means "created, never moved". */
  private transitionCount(workItemId: string): number {
    return (
      this.db
        .query<{ n: number }, [number, string]>(
          "SELECT COUNT(*) AS n FROM work_item_transitions WHERE domain_id = ? AND work_item_id = ?",
        )
        .get(this.domainId, workItemId)?.n ?? 0
    );
  }

  /**
   * Is `row` a *shadow* of `value` — a placeholder holding nothing the caller would lose?
   *
   * Three conditions, all necessary (#3254):
   *
   *  1. **Its id is the one `value` itself mints.** A row called `branch:feat/x` was created
   *     because that branch appeared with nothing else known about it. A row called `#3066`
   *     that merely happens to carry the same branch is a tracked issue, not a shadow.
   *  2. **It claims no other identity key.** A row with a PR *and* the branch is the record
   *     of a real PR; folding it away would drop the PR binding.
   *  3. **Its transition log holds only its creation.** This is the manifest-agnostic spelling
   *     of "nothing has happened to it yet" — the db layer cannot know a project's initial
   *     phase, but it can see that the row has never moved. A shadow that reached `qa` has
   *     accumulated history somebody meant, and merging silently discards it.
   *
   * Deliberately *not* checked: phase state in `alias_state`. It lives in another module and
   * another table, so a shadow that somehow carries scratchpad keys loses them here. Condition
   * 3 is what keeps that theoretical: a row nobody advanced is a row no phase script wrote for.
   */
  private isAbsorbableShadow(row: WorkItem, field: WorkItemKeyField, value: string | number): boolean {
    const mintedHere = shadowIdSpellings(field, value).some((base) =>
      workItemIdCandidates(this.domainId, base).includes(row.id),
    );
    if (!mintedHere) return false;
    if (field !== "branch" && row.branch !== null) return false;
    if (field !== "prNumber" && row.prNumber !== null) return false;
    if (field !== "issueNumber" && row.issueNumber !== null) return false;
    return this.transitionCount(row.id) <= 1;
  }

  /**
   * Clear the way for a patch that claims unique keys, or refuse in the open.
   *
   * **Must be called inside the caller's transaction** — it deletes rows, and a later failure
   * in the same write has to take those deletions with it.
   *
   * Returns the ids it absorbed so the caller can report them. An absorbed row is a deletion
   * the caller never asked for, and #3254's whole complaint was state changing under an
   * orchestrator with no explanation; silence here would repeat that from the other side.
   */
  private resolveKeyConflicts(
    targetId: string,
    target: Pick<WorkItem, "branch" | "prNumber" | "issueNumber">,
    patch: WorkItemPatch,
  ): string[] {
    const absorbed: string[] = [];

    const claim = (
      field: WorkItemKeyField,
      value: string | number | null | undefined,
      current: string | number | null,
      findOwner: () => WorkItem | null,
    ): void => {
      // null/undefined is "clear" or "leave alone" — neither can collide.
      if (value === null || value === undefined || value === current) return;
      const owner = findOwner();
      if (!owner || owner.id === targetId) return;
      if (this.isAbsorbableShadow(owner, field, value)) {
        this.deleteWorkItem(owner.id);
        absorbed.push(owner.id);
        return;
      }
      throw new WorkItemConflictError(targetId, owner.id, field, value);
    };

    claim("branch", patch.branch, target.branch, () => this.getWorkItemByBranch(String(patch.branch)));
    claim("prNumber", patch.prNumber, target.prNumber, () => this.getWorkItemByPr(Number(patch.prNumber)));
    claim("issueNumber", patch.issueNumber, target.issueNumber, () =>
      this.getWorkItemByIssue(Number(patch.issueNumber)),
    );

    return absorbed;
  }

  updateWorkItem(
    id: string,
    patch: WorkItemPatch,
    opts?: {
      forced?: boolean;
      forceReason?: string;
      expectedVersion?: number;
      /** Called after commit with the shadow ids folded into this item. See resolveKeyConflicts. */
      onAbsorb?: (absorbedIds: string[]) => void;
    },
  ): WorkItem {
    const absorbedIds: string[] = [];
    const updated = this.updateWorkItemTx(id, patch, absorbedIds, opts);
    if (absorbedIds.length > 0) opts?.onAbsorb?.(absorbedIds);
    return updated;
  }

  private updateWorkItemTx(
    id: string,
    patch: WorkItemPatch,
    absorbedIds: string[],
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
        const values: Record<string, unknown> = {
          $id: existing.id,
          $domain_id: this.domainId,
          $version: existing.version,
        };

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
          ["automationOverrides", "automation_overrides"],
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

        // Inside the transaction on purpose: an absorbed shadow must roll back with the
        // update it was clearing the way for.
        absorbedIds.push(...this.resolveKeyConflicts(existing.id, existing, patch));

        fields.push("updated_at = datetime('now')");
        fields.push("version = version + 1");

        const result = this.db
          .prepare(
            `UPDATE work_items SET ${fields.join(", ")} WHERE domain_id = $domain_id AND id = $id AND version = $version`,
          )
          .run(values as Record<string, string | number | null>);

        if (result.changes === 0) {
          throw new StaleUpdateError(id, existing.version);
        }

        if (patch.phase !== undefined && patch.phase !== existing.phase) {
          this.recordTransition(existing.id, existing.phase, patch.phase, opts?.forced ?? false, opts?.forceReason);
        }

        const updated = this.getWorkItem(existing.id);
        if (!updated) throw new Error(`failed to read back work item: ${id}`);
        return updated;
      })
      .immediate();
  }

  /**
   * Append to the transition log.
   *
   * `domain_id` is written here because it is written *everywhere* on this handle — the
   * column had no writer at all when the domain partitioning landed (#3034 round 2), so
   * every transition row said `domain_id = 0` and `StateDb.countDomainDependents` reported
   * zero transitions for a domain that had hundreds, making `mcx domain rm` willing to
   * orphan them. That was a forgotten argument in one INSERT; on a domain-bound handle
   * there is no argument to forget.
   */
  recordTransition(
    workItemId: string,
    fromPhase: string | null,
    toPhase: string,
    forced: boolean,
    forceReason?: string,
  ): void {
    // domain_id is inherited from the parent work item rather than defaulted. A
    // denormalized column with no writer is worse than no column: countDomainDependents
    // is the function deleteDomain's refusal invariant lives in, and with every row at 0
    // it reported a confident zero while a cascade orphaned the item's whole history
    // (#3034 review Y5).
    this.db
      .query(
        `INSERT INTO work_item_transitions (work_item_id, domain_id, from_phase, to_phase, forced, force_reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workItemId, this.domainId, fromPhase, toPhase, forced ? 1 : 0, forceReason ?? null);
  }

  listTransitions(workItemId: string): WorkItemTransition[] {
    return this.db
      .query<WorkItemTransitionRow, [number, string]>(
        "SELECT * FROM work_item_transitions WHERE domain_id = ? AND work_item_id = ? ORDER BY id",
      )
      .all(this.domainId, this.storedId(workItemId) ?? workItemId)
      .map(rowToTransition);
  }

  deleteWorkItem(id: string): boolean {
    return this.db.transaction(() => {
      const stored = this.storedId(id);
      if (stored === null) return false;
      const row = this.db
        .query<{ pr_number: number | null }, [number, string]>(
          "SELECT pr_number FROM work_items WHERE domain_id = ? AND id = ?",
        )
        .get(this.domainId, stored);
      if (row?.pr_number !== null && row?.pr_number !== undefined) {
        this.db
          .query("DELETE FROM ci_run_states WHERE domain_id = ? AND pr_number = ?")
          .run(this.domainId, row.pr_number);
      }
      this.db
        .query("DELETE FROM work_item_transitions WHERE domain_id = ? AND work_item_id = ?")
        .run(this.domainId, stored);
      this.db.query("DELETE FROM work_items WHERE domain_id = ? AND id = ?").run(this.domainId, stored);
      return (this.db.query<{ c: number }, []>("SELECT changes() as c").get()?.c ?? 0) > 0;
    })();
  }

  listWorkItems(filter?: { phase?: string; excludeArchived?: boolean }): WorkItem[] {
    const archiveClause = filter?.excludeArchived
      ? " AND NOT (phase = 'done' AND datetime(updated_at) < datetime('now', '-7 days'))"
      : "";

    if (filter?.phase) {
      return this.db
        .query<WorkItemRow, [number, string]>(
          `SELECT * FROM work_items WHERE domain_id = ? AND phase = ?${archiveClause} ORDER BY created_at`,
        )
        .all(this.domainId, filter.phase)
        .map(rowToWorkItem);
    }
    return this.db
      .query<WorkItemRow, [number]>(`SELECT * FROM work_items WHERE domain_id = ?${archiveClause} ORDER BY created_at`)
      .all(this.domainId)
      .map(rowToWorkItem);
  }

  /** Every row in this domain, ignoring any caller filter. See WorkItemDb.strandedUnassignedCount. */
  countWorkItems(): number {
    return (
      this.db
        .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM work_items WHERE domain_id = ?")
        .get(this.domainId)?.n ?? 0
    );
  }

  /** Count items that listWorkItems would hide when excludeArchived=true. */
  countArchivedWorkItems(): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) as n FROM work_items WHERE domain_id = ? AND phase = 'done' AND datetime(updated_at) < datetime('now', '-7 days')",
        )
        .get(this.domainId)?.n ?? 0
    );
  }

  // Lookups by a per-domain unique key. `WHERE pr_number = 42` alone is ambiguous the
  // moment two domains each have a PR #42 — SQLite would return an arbitrary row (#3034).

  getWorkItemByPr(prNumber: number): WorkItem | null {
    const row = this.db
      .query<WorkItemRow, [number, number]>("SELECT * FROM work_items WHERE domain_id = ? AND pr_number = ?")
      .get(this.domainId, prNumber);
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemByIssue(issueNumber: number): WorkItem | null {
    const row = this.db
      .query<WorkItemRow, [number, number]>("SELECT * FROM work_items WHERE domain_id = ? AND issue_number = ?")
      .get(this.domainId, issueNumber);
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemByBranch(branch: string): WorkItem | null {
    const row = this.db
      .query<WorkItemRow, [number, string]>("SELECT * FROM work_items WHERE domain_id = ? AND branch = ?")
      .get(this.domainId, branch);
    return row ? rowToWorkItem(row) : null;
  }

  /** Get the last-seen HEAD commit OID for a PR, used by the push detector. Returns null if not yet seen. */
  getLastSeenHeadOid(prNumber: number): string | null {
    const row = this.db
      .query<{ last_seen_head_oid: string | null }, [number, number]>(
        "SELECT last_seen_head_oid FROM work_items WHERE domain_id = ? AND pr_number = ?",
      )
      .get(this.domainId, prNumber);
    return row?.last_seen_head_oid ?? null;
  }

  /** Persist the HEAD commit OID for a PR so the push detector survives daemon restarts. */
  setLastSeenHeadOid(prNumber: number, oid: string): void {
    this.db
      .prepare("UPDATE work_items SET last_seen_head_oid = ? WHERE domain_id = ? AND pr_number = ?")
      .run(oid, this.domainId, prNumber);
  }

  // -- CI run states --

  loadCiRunStates(): Map<number, CiRunState> {
    const rows = this.db
      .query<
        { pr_number: number; suite_id: number; started_at: number; emitted_started: number; emitted_finished: number },
        [number]
      >(
        "SELECT pr_number, suite_id, started_at, emitted_started, emitted_finished FROM ci_run_states WHERE domain_id = ?",
      )
      .all(this.domainId);
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
        `INSERT INTO ci_run_states (domain_id, pr_number, suite_id, started_at, emitted_started, emitted_finished)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain_id, pr_number) DO UPDATE SET
           suite_id = excluded.suite_id,
           started_at = excluded.started_at,
           emitted_started = excluded.emitted_started,
           emitted_finished = excluded.emitted_finished`,
      )
      .run(
        this.domainId,
        prNumber,
        state.suiteId,
        state.startedAt,
        state.emittedStarted ? 1 : 0,
        state.emittedFinished ? 1 : 0,
      );
  }

  deleteCiRunState(prNumber: number): void {
    this.db.prepare("DELETE FROM ci_run_states WHERE domain_id = ? AND pr_number = ?").run(this.domainId, prNumber);
  }

  /**
   * Atomically create or update a work item in this domain.
   * Uses INSERT ... ON CONFLICT(id) DO UPDATE to avoid TOCTOU races.
   *
   * `id` is the table's global primary key, so the `ON CONFLICT` arm carries a `WHERE
   * domain_id = …` guard: without it, a caller in domain B writing an id that domain A
   * already owns would silently *update A's row* — a cross-partition write straight through
   * a tool the caller is allowed to use. Guarded, the arm matches nothing, the read-back
   * finds nothing in this domain, and the call throws instead of corrupting a neighbour.
   */
  upsertWorkItem(
    item: WorkItemPatch & { id: string },
    opts?: { onAbsorb?: (absorbedIds: string[]) => void },
  ): WorkItem {
    const absorbedIds: string[] = [];
    const result = this.upsertWorkItemTx(item, absorbedIds);
    if (absorbedIds.length > 0) opts?.onAbsorb?.(absorbedIds);
    return result;
  }

  /**
   * Wrapped in a transaction so the shadow absorption in {@link resolveKeyConflicts} and the
   * upsert it unblocks either both land or neither does — previously this was a bare
   * read-then-write pair.
   */
  private upsertWorkItemTx(item: WorkItemPatch & { id: string }, absorbedIds: string[]): WorkItem {
    return this.db
      .transaction(() => {
        const before = this.getWorkItem(item.id);
        const id = before?.id ?? domainScopedWorkItemId(this.domainId, item.id);
        absorbedIds.push(
          ...this.resolveKeyConflicts(id, before ?? { branch: null, prNumber: null, issueNumber: null }, item),
        );
        return this.upsertRow(id, before, item);
      })
      .immediate();
  }

  private upsertRow(id: string, before: WorkItem | null, item: WorkItemPatch & { id: string }): WorkItem {
    this.db
      .query(
        `INSERT INTO work_items (id, domain_id, issue_number, branch, pr_number, pr_state, pr_url, ci_status, ci_run_id, ci_summary, review_status, merge_state_status, phase)
         VALUES ($id, $domain_id, $issue_number, $branch, $pr_number, $pr_state, $pr_url, $ci_status, $ci_run_id, $ci_summary, $review_status, $merge_state_status, $phase)
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
           updated_at         = datetime('now')
         WHERE work_items.domain_id = $domain_id`,
      )
      .run({
        $id: id,
        $domain_id: this.domainId,
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

    const result = this.getWorkItem(id);
    if (!result) {
      throw new Error(
        `failed to read back work item ${id} in domain ${this.domainId}: the id exists but belongs to another domain`,
      );
    }
    // Only log when we have a phase to log. Upsert can insert a row without a
    // phase value (SQLite DEFAULT is bypassed by explicit NULL); in that case
    // the transition log stays empty until a phase is assigned.
    if (result.phase) {
      if (!before) {
        this.recordTransition(result.id, null, result.phase, false);
      } else if (before.phase !== result.phase) {
        this.recordTransition(result.id, before.phase, result.phase, false);
      }
    }
    return result;
  }
}
