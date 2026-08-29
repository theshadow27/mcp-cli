/**
 * SQLite persistence layer for daemon state.
 *
 * Uses bun:sqlite for zero-dependency persistence of:
 * - Tool cache (survive daemon restarts)
 * - Usage statistics
 * - Daemon state (config hash, etc.)
 */

import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AliasType,
  type BudgetConfig,
  type Domain,
  type MailMessage,
  type MonitorAliasMetadata,
  NO_DOMAIN_ID,
  type Span,
  type SpanRow,
  type ToolInfo,
  type UsageStat,
  canonicalizeDomainPath,
  formatDomainLocation,
  hardenFile,
  isValidDomainHost,
  isValidDomainName,
  listPartitionedTables,
  options,
  resolveDomainForPath,
  resolveRealpath,
} from "@mcp-cli/core";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export type { UsageStat } from "@mcp-cli/core";

export interface AgentSessionRow {
  sessionId: string;
  name: string | null;
  provider: string;
  pid: number | null;
  pidStartTime: number | null;
  state: string;
  model: string | null;
  cwd: string | null;
  worktree: string | null;
  repoRoot: string | null;
  totalCost: number;
  totalTokens: number;
  spawnedAt: string;
  endedAt: string | null;
  claudeSessionId: string | null;
  transport: string | null;
  /**
   * Domain that owns this session, or `NO_DOMAIN_ID` when it was spawned outside
   * every registered domain (#3039).
   *
   * Read back, not just written: `claude-server.ts` rebuilds the worker's live
   * sessions from these rows after a daemon restart, and a restored session with
   * no domain disappears from every domain-scoped `mcx claude ls` — at exactly
   * the moment nobody is watching.
   */
  domainId: number;
}

/** @deprecated Use AgentSessionRow instead. */
export type ClaudeSessionRow = AgentSessionRow;

/**
 * {@link McxDb.deleteDomain} refusing because the domain still owns rows.
 *
 * A **type**, not a message, because the caller has to distinguish this from a real
 * failure and prose is not a contract (`no-error-message-sniffing`). Before this class
 * existed, `handlers/domain.ts` re-counted dependents on *any* throw and reported a
 * non-empty count as this refusal — so `SQLITE_FULL`, corruption or a
 * `SQLITE_BUSY_SNAPSHOT` from the DEFERRED transaction all reached the operator as
 * "re-run with --force", with the real error discarded and `--force` already passed
 * (#3180).
 *
 * `dependents` is the count the refusal was *decided* on, taken inside the transaction,
 * so the caller renders that rather than re-reading a database that has since moved.
 */
export class DomainHasDependentsError extends Error {
  readonly domainName: string;
  readonly dependents: Array<{ table: string; rows: number }>;
  /**
   * Cross-domain messages in **other** partitions whose stamped return address names this
   * domain (#3247). Not a `dependents` entry, because those are rows carrying this
   * domain's `domain_id` and a cascade deletes them — these are another partition's rows
   * that merely *mention* the name, and the cascade deliberately leaves them alone.
   */
  readonly strandedSenders: number;

  constructor(name: string, dependents: Array<{ table: string; rows: number }>, strandedSenders = 0) {
    super(describeDomainRefusal(name, dependents, strandedSenders));
    this.name = "DomainHasDependentsError";
    this.domainName = name;
    this.dependents = dependents;
    this.strandedSenders = strandedSenders;
  }
}

/**
 * The refusal prose for {@link DomainHasDependentsError}, as two independently-omittable
 * clauses.
 *
 * Two, not one interpolated sentence, because the two halves have **different remedies**:
 * dependent rows go away with `--cascade`, stamped senders do not. A single sentence that
 * ended "pass cascade to remove them" while cascade left half of them in place is the kind
 * of confidently-wrong advice `handlers/domain.ts` already had to unwind once (#3180).
 * With no stranded senders the string is byte-identical to what #3180 shipped.
 */
function describeDomainRefusal(name: string, dependents: Array<{ table: string; rows: number }>, stranded: number) {
  const clauses: string[] = [];
  if (dependents.length > 0) {
    const detail = dependents.map((d) => `${d.table}=${d.rows}`).join(", ");
    const total = dependents.reduce((n, d) => n + d.rows, 0);
    clauses.push(
      `still has ${total} dependent row(s) (${detail}); reassign or delete them first, or pass cascade to remove them with the domain`,
    );
  }
  if (stranded > 0) {
    clauses.push(
      `is the stamped return address of ${stranded} cross-domain message(s) held in other partitions; removing it leaves their replies unresolvable until a domain is registered under this name again — pass cascade to accept that`,
    );
  }
  return `domain "${name}" ${clauses.join(", and ")}`;
}

/**
 * {@link McxDb.createDomain} or {@link McxDb.renameDomain} refusing because another
 * domain already holds the name or the location.
 *
 * A **type**, not a message, for the same reason as {@link DomainHasDependentsError}: the
 * `no-error-message-sniffing` rule means a caller that has to tell "this name is taken"
 * from "the disk is full" cannot do it by reading prose.
 *
 * `existing` is the conflicting domain as read *inside* the deciding transaction, so what
 * a caller renders is what the refusal was decided on and not a re-read of a database that
 * has moved since. The message is built here rather than at each call site because the
 * whole point of the pre-check this replaced was to *name* the conflicting domain, and a
 * second copy of that sentence is a second thing to drift.
 *
 * Nothing catches this today, deliberately: unlike a `deleteDomain` refusal — which is a
 * *result*, because the caller has to render per-table counts and decide about `--cascade`
 * — a name/location collision is simply an error, and `handlers/domain.ts` lets it
 * propagate with its message intact. The type is what makes that a choice rather than an
 * assumption.
 */
export class DomainConflictError extends Error {
  /** Which uniqueness constraint the write would have violated. */
  readonly conflict: "name" | "location";
  /** The domain already holding it, read inside the transaction that refused. */
  readonly existing: Domain;

  constructor(conflict: "name" | "location", attempted: string, existing: Domain) {
    super(
      conflict === "name"
        ? `domain "${attempted}" already exists at ${formatDomainLocation(existing)}`
        : `${attempted} is already domain "${existing.name}"`,
    );
    this.name = "DomainConflictError";
    this.conflict = conflict;
    this.existing = existing;
  }
}

/**
 * SQL predicate: `mail.sender` is `local@?1` with a non-empty local part.
 *
 * One definition shared by the rename rewrite and the delete count, because "which rows
 * name this domain" is a single question and two spellings of it would answer differently
 * the first time one of them was tweaked — the count would refuse over rows the rewrite
 * skipped, or the rewrite would touch rows the count never warned about. `?1` is the
 * domain name in both callers. See {@link McxDb.restampMailSenders} for why this is
 * `substr` and not `LIKE`.
 */
const SENDER_STAMPED_WITH =
  "length(sender) > length(?1) + 1 AND substr(sender, length(sender) - length(?1)) = '@' || ?1";

export class McxDb {
  private db: Database;
  private logInsertCount = new Map<string, number>();
  private mailOpCount = 0;
  private aliasOpCount = 0;

  /** Expose the raw bun:sqlite Database for modules that share this connection (e.g. WorkItemDb). */
  get database(): Database {
    return this.db;
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    hardenFile(dbPath);
    // busy_timeout FIRST: `journal_mode = WAL` itself takes a lock, so setting the
    // timeout after it leaves a concurrent open able to die with SQLITE_BUSY inside the
    // constructor. The daemon's flock covers the daemon, not tests or a direct opener.
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  /** Expose the raw bun:sqlite Database for sibling modules (e.g. WorkItemDb). */
  getDatabase(): Database {
    return this.db;
  }

  // -- Migrations --

  /**
   * Per-consumer versioned migration using a shared `schema_versions(name, version)` table.
   *
   * Replaces the legacy bare try/catch-discard pattern that
   * swallowed ALL exceptions (disk-full, permissions, corruption). Each migration
   * step and its version bump are atomic (single transaction); failures bubble up.
   *
   * Legacy handling: existing databases are detected by `tool_cache` presence.
   * We still run applyV1Schema() on legacy DBs (all IF NOT EXISTS — safe no-op on
   * healthy DBs) to recover any tables that the old bare try/catch silently failed
   * to create (e.g. copilot_comment_state on a half-migrated DB).
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        name    TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);

    const CONSUMER = "state";
    let version = this.db
      .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
      .get(CONSUMER)?.version;

    if (version === undefined) {
      const hasToolCache =
        this.db
          .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='tool_cache'")
          .get()?.n ?? 0;

      if (hasToolCache > 0) {
        // Existing DB — run schema DDL idempotently to recover any tables the old
        // try/catch code silently failed to create (e.g. copilot_comment_state).
        this.applyV1Schema();
        // Stamp at v2 (not v3) so the v3 symlink-canonicalization step runs on first
        // open of any legacy DB — fixes the regression introduced by #1887 where
        // legacy DBs were stamped directly at v3, bypassing the canonicalization that
        // previously ran unconditionally on every boot (#1892).
        version = 2;
      } else {
        // Fresh DB, or ancient DB that only has claude_sessions.
        // Rename claude_sessions → agent_sessions before v1 creates the table fresh.
        const hasClaude =
          this.db
            .query<{ n: number }, []>(
              "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='claude_sessions'",
            )
            .get()?.n ?? 0;
        if (hasClaude > 0) {
          this.db.exec("ALTER TABLE claude_sessions RENAME TO agent_sessions");
          const cols = new Set(
            (this.db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map((r) => r.name),
          );
          for (const [col, def] of [
            ["provider", "TEXT NOT NULL DEFAULT 'claude'"],
            ["repo_root", "TEXT"],
            ["pid_start_time", "INTEGER"],
            ["name", "TEXT"],
            ["domain_id", "INTEGER NOT NULL DEFAULT 0"],
          ] as const) {
            if (!cols.has(col)) {
              this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} ${def}`);
            }
          }
        }
        version = 0;
      }
      this.db
        .query<void, [string, number]>("INSERT OR IGNORE INTO schema_versions (name, version) VALUES (?, ?)")
        .run(CONSUMER, version);
    }

    if (version < 1) {
      this.db.transaction(() => {
        this.applyV1Schema();
        this.setSchemaVersion(CONSUMER, 1);
      })();
      version = 1;
    }

    if (version < 2) {
      // Canonicalize alias_state rows written with trailing-slash repo_root.
      this.db.transaction(() => {
        this.db.run(`
          DELETE FROM alias_state
          WHERE repo_root LIKE '%/'
            AND EXISTS (
              SELECT 1 FROM alias_state AS canonical
              WHERE canonical.repo_root = rtrim(alias_state.repo_root, '/')
                AND canonical.namespace  = alias_state.namespace
                AND canonical.key        = alias_state.key
            )
        `);
        this.db.run(`
          UPDATE alias_state
          SET repo_root = rtrim(repo_root, '/')
          WHERE repo_root LIKE '%/'
        `);
        this.setSchemaVersion(CONSUMER, 2);
      })();
      version = 2;
    }

    if (version < 3) {
      // Canonicalize alias_state rows written with symlink repo_root (#1526).
      const symRows = this.db.query<{ repo_root: string }, []>("SELECT DISTINCT repo_root FROM alias_state").all();
      const toUpdate = symRows.filter(({ repo_root }) => {
        try {
          return resolveRealpath(resolve(repo_root)) !== repo_root;
        } catch {
          return false;
        }
      });
      this.db.transaction(() => {
        for (const { repo_root } of toUpdate) {
          const canonical = resolveRealpath(resolve(repo_root));
          this.db.run(
            `DELETE FROM alias_state
             WHERE repo_root = ?
               AND EXISTS (
                 SELECT 1 FROM alias_state AS c
                 WHERE c.repo_root = ? AND c.namespace = alias_state.namespace AND c.key = alias_state.key
               )`,
            [repo_root, canonical],
          );
          this.db.run("UPDATE alias_state SET repo_root = ? WHERE repo_root = ?", [canonical, repo_root]);
        }
        this.setSchemaVersion(CONSUMER, 3);
      })();
      version = 3;
    }

    if (version < 4) {
      // Canonicalize agent_sessions rows written with symlink repo_root (#1684).
      const hasAgentSessions =
        (this.db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
          )
          .get()?.n ?? 0) > 0;
      const symRows = hasAgentSessions
        ? this.db
            .query<{ repo_root: string }, []>(
              "SELECT DISTINCT repo_root FROM agent_sessions WHERE repo_root IS NOT NULL",
            )
            .all()
        : [];
      const updates = symRows
        .map(({ repo_root }) => {
          try {
            const canonical = resolveRealpath(resolve(repo_root));
            return canonical !== repo_root ? { old: repo_root, canonical } : null;
          } catch {
            return null;
          }
        })
        .filter((u): u is { old: string; canonical: string } => u !== null);
      this.db.transaction(() => {
        for (const { old, canonical } of updates) {
          this.db.run("UPDATE agent_sessions SET repo_root = ? WHERE repo_root = ?", [canonical, old]);
        }
        this.setSchemaVersion(CONSUMER, 4);
      })();
      version = 4;
    }

    if (version < 5) {
      // Add repo_poll_ts column to copilot_comment_state (#1792).
      // Separates the repo-level poll watermark (ISO-8601, used as GitHub `since=`) from the
      // per-PR last_poll_ts (SQLite datetime format), which previously shared the same column
      // via a sentinel row (pr_number = 0).
      const hasCopilotState =
        (this.db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='copilot_comment_state'",
          )
          .get()?.n ?? 0) > 0;
      this.db.transaction(() => {
        if (hasCopilotState) {
          const hasCol = (
            this.db.prepare("PRAGMA table_info(copilot_comment_state)").all() as Array<{ name: string }>
          ).some((r) => r.name === "repo_poll_ts");
          if (!hasCol) {
            this.db.exec("ALTER TABLE copilot_comment_state ADD COLUMN repo_poll_ts TEXT");
          }
          // Migrate: copy the sentinel row's last_poll_ts → repo_poll_ts.
          // The sentinel row (pr_number = 0) holds the repo-level poll watermark in ISO-8601 format.
          this.db.exec(
            "UPDATE copilot_comment_state SET repo_poll_ts = last_poll_ts WHERE pr_number = 0 AND repo_poll_ts IS NULL",
          );
        }
        this.setSchemaVersion(CONSUMER, 5);
      })();
      version = 5;
    }

    if (version < 6) {
      this.db.transaction(() => {
        const hasAgentSessions =
          (this.db
            .query<{ n: number }, []>(
              "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
            )
            .get()?.n ?? 0) > 0;
        if (hasAgentSessions) {
          const hasCol = (this.db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).some(
            (r) => r.name === "claude_session_id",
          );
          if (!hasCol) {
            this.db.exec("ALTER TABLE agent_sessions ADD COLUMN claude_session_id TEXT");
          }
        }
        this.setSchemaVersion(CONSUMER, 6);
      })();
      version = 6;
    }

    if (version < 7) {
      this.db.transaction(() => {
        const hasAgentSessions =
          (this.db
            .query<{ n: number }, []>(
              "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
            )
            .get()?.n ?? 0) > 0;
        if (hasAgentSessions) {
          const hasCol = (this.db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).some(
            (r) => r.name === "transport",
          );
          if (!hasCol) {
            this.db.exec("ALTER TABLE agent_sessions ADD COLUMN transport TEXT");
          }
        }
        this.setSchemaVersion(CONSUMER, 7);
      })();
      version = 7;
    }

    // v8 (#3038): every mail query is now domain-scoped — insertMail / readMail /
    // getNextUnread / getMailById / markMailRead all take a required domainId and all
    // predicate on domain_id, so the partition has to lead the index.
    //
    // This is a version step and NOT an edit to applyV1Schema, which is what the warning
    // on that method forbids: the ladder is already past 1, so an index change written
    // there would run on fresh test databases (green forever) and never on any mcx.db
    // that had already booted a #3143 binary (silent production drift). Schema changes
    // that tests cannot catch are exactly the ones that need a step of their own.
    //
    // idx_mail_recipient is dropped rather than kept alongside: no query can use a
    // (recipient, read, created_at) index once every predicate leads with domain_id, so
    // leaving it is pure write amplification.
    if (version < 8) {
      this.db.transaction(() => {
        // Guarded on the table existing, the same way v7 guards `agent_sessions`. A
        // database can sit at version N with the table absent — schema_versions may be
        // seeded by a racing process before any table is created, and applyV1Schema only
        // runs at version < 1, so it will not backfill. `CREATE INDEX ... ON mail` would
        // then throw "no such table" and take the whole daemon start with it.
        const hasMail =
          (this.db
            .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='mail'")
            .get()?.n ?? 0) > 0;
        if (hasMail) {
          this.db.exec("DROP INDEX IF EXISTS idx_mail_recipient");
          this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_mail_domain_recipient ON mail(domain_id, recipient, read, created_at)",
          );
        }
        this.setSchemaVersion(CONSUMER, 8);
      })();
      version = 8;
    }

    // v9 (#3210): give `domains` the constraint its callers were only enforcing by
    // convention — `CHECK (path LIKE '/%' OR host IS NOT NULL)`.
    //
    // Why the table needs it and not just the writers: `resolveDomainForPath` calls
    // `normalizeDomainPath` on EVERY row inside its resolution loop, and that throws on a
    // path that is not absolute. So a single malformed row breaks `mcx domain which` for
    // every query — including the one an operator would reach for to diagnose it — while
    // `mcx domain ls` keeps working, because it never normalizes. #3160 closed the two
    // write paths that could produce such a row; this closes the table.
    //
    // It is a REBUILD because SQLite has no `ADD CONSTRAINT`, which makes this the most
    // dangerous shape a migration can have — see #3152, where an un-transactional
    // `ALTER TABLE` permanently bricked the daemon for anyone whose process died between
    // the DDL and the version bump. So, in order:
    //
    //   - the pragma read happens BEFORE `BEGIN`. `PRAGMA foreign_keys` is a no-op inside
    //     a transaction, so a rebuild that toggles it there silently does not toggle it —
    //     the other half of #3152. Nothing in this directory ever turns foreign keys on
    //     (`domains.spec.ts` asserts it), and no table references `domains`, so this is
    //     restoring a state rather than fixing a live bug. It is written this way because
    //     the ordering is the invariant, not the current value.
    //   - the DDL and `setSchemaVersion` are ONE transaction, so a crash mid-rebuild
    //     leaves the old table and the old version and the next start retries.
    //   - `.immediate()`, because the body reads (`sqlite_sequence`, the row scan) before
    //     it writes; see `deleteDomain` for why DEFERRED loses that race under WAL.
    //
    // Written as a step rather than into `applyV1Schema` for the reason spelled out on
    // v8 — and here it also means the rebuild runs on every fresh database, including
    // every test one, instead of being a path only real users' data ever takes.
    if (version < 9) {
      const foreignKeysOn =
        (this.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0) === 1;
      if (foreignKeysOn) this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db
          .transaction(() => {
            this.rebuildDomainsWithPathCheck();
            this.setSchemaVersion(CONSUMER, 9);
          })
          .immediate();
      } finally {
        if (foreignKeysOn) this.db.exec("PRAGMA foreign_keys = ON");
      }
      version = 9;
    }

    if (version < 10) {
      this.db.transaction(() => {
        // Per-thread last-seen `version` cursor for the Trouter watch stream
        // (`mcx watch`). One row per (site, thread); the value is the epoch-ms
        // `version` high-water mark used for dedup and REST gap-fill on reconnect.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS site_watch_cursor (
            site         TEXT NOT NULL,
            thread       TEXT NOT NULL,
            last_version TEXT NOT NULL,
            updated_at   INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (site, thread)
          )
        `);
        this.setSchemaVersion(CONSUMER, 10);
      })();
      version = 10;
    }
  }

  /**
   * The v9 table rebuild, in the body of the transaction that owns it.
   *
   * Rows that would fail the new CHECK are moved to `domains_rejected` rather than
   * dropped or left to abort the INSERT. Aborting is the #3152 failure mode wearing a
   * different hat — a daemon that cannot start, for data it is refusing to lose — and
   * silently deleting a row is worse than the broken state it came from. No writer can
   * produce such a row today, so in practice this table is never created; it exists so
   * that the one database that does have one still boots, with the row recoverable.
   *
   * Dependent rows keep their `domain_id` through all of this: the ids are copied
   * verbatim, and `sqlite_sequence` is restored to the OLD high-water mark rather than
   * left at `max(id)` of the copy. Without that, deleting the newest domain before an
   * upgrade would let the next `AUTOINCREMENT` hand its id out again — the exact
   * adoption bug `AUTOINCREMENT` is on this table to prevent (#3034 review B6).
   */
  private rebuildDomainsWithPathCheck(): void {
    const hasDomains =
      (this.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='domains'")
        .get()?.n ?? 0) > 0;
    // Guarded the same way v7 and v8 guard theirs: a database can sit at version N with
    // the table absent, and `applyV1Schema` only runs below v1 so it will not backfill.
    if (!hasDomains) return;

    // `sqlite_sequence` is created by SQLite alongside the first AUTOINCREMENT table, so
    // it exists wherever `domains` does — but querying a missing one throws "no such
    // table", which inside this transaction means a daemon that will not start, so the
    // read is guarded rather than assumed.
    const hasSequence =
      (this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'").get()
        ?.n ?? 0) > 0;
    const seq = hasSequence
      ? this.db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'domains'").get()?.seq
      : undefined;

    this.db.exec(`
      CREATE TABLE domains_v9 (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        host       TEXT,
        path       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        -- A local domain's path must be absolute; a host-bound one is that host's to
        -- interpret. Deliberately NOT a check that the path exists — that is a
        -- registration-time rule (#3210) and the filesystem is not in this transaction.
        CHECK (path LIKE '/%' OR host IS NOT NULL)
      )
    `);

    const rejected =
      this.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM domains WHERE NOT (path LIKE '/%' OR host IS NOT NULL)")
        .get()?.n ?? 0;
    if (rejected > 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS domains_rejected (
          id INTEGER, name TEXT, host TEXT, path TEXT, created_at TEXT
        )
      `);
      this.db.exec(`
        INSERT INTO domains_rejected (id, name, host, path, created_at)
        SELECT id, name, host, path, created_at FROM domains
         WHERE NOT (path LIKE '/%' OR host IS NOT NULL)
      `);
    }

    this.db.exec(`
      INSERT INTO domains_v9 (id, name, host, path, created_at)
      SELECT id, name, host, path, created_at FROM domains
       WHERE path LIKE '/%' OR host IS NOT NULL
    `);
    this.db.exec("DROP TABLE domains");
    this.db.exec("ALTER TABLE domains_v9 RENAME TO domains");
    // Recreated because DROP took the old one with it.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_location ON domains(COALESCE(host, ''), path)");
    if (seq !== undefined) {
      // DELETE + INSERT rather than UPDATE: the copy has no `sqlite_sequence` row at all
      // when every row was rejected, and one row is the whole table's state either way.
      this.db.run("DELETE FROM sqlite_sequence WHERE name = 'domains'");
      this.db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('domains', ?)", [seq]);
    }
  }

  /**
   * The v1 schema.
   *
   * **Do not add columns or tables to this method, or to any historical `if (version < N)`
   * branch, in a later PR.** #3034 could write `domain_id` directly into these because
   * `mcx.db` did not exist yet, so every database was fresh. From PR 2 of this arc
   * onwards that is no longer true: an edit here silently no-ops on every already-created
   * `mcx.db`, because `CREATE TABLE IF NOT EXISTS` finds the old shape and keeps it.
   * New columns get a new `if (version < N)` step with `addColumnIfMissing`.
   */
  private applyV1Schema(): void {
    this.db.exec(`
      -- Domains: mcx's DNS. A name bound to a location, and nothing else (#3034).
      -- No state column, deliberately: a domain can resolve while its machine is down,
      -- and a machine can be up while its loop is off. See docs/domains.md.
      -- AUTOINCREMENT, not bare INTEGER PRIMARY KEY: without it SQLite reuses the rowid
      -- of a deleted domain, and any row still carrying that domain_id is silently
      -- adopted by the next domain created — a new project inheriting a dead one's work
      -- items, mail and PR watermarks (#3034 review B6).
      -- The CHECK on path that this table carries is NOT written here: it is added by the
      -- v9 rebuild below, which every database runs, so the two paths cannot drift apart
      -- the way a copy written in both places would.
      CREATE TABLE IF NOT EXISTS domains (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        host       TEXT,
        path       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- One domain per location. COALESCE because SQLite treats NULLs as distinct in a
      -- UNIQUE index, which would let two local domains share a path and make
      -- resolveDomainForPath's longest-prefix rule ambiguous.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_location
        ON domains(COALESCE(host, ''), path);

      CREATE TABLE IF NOT EXISTS tool_cache (
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT,
        input_schema_json TEXT,
        signature TEXT,
        cached_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (server_name, tool_name)
      );

      CREATE TABLE IF NOT EXISTS usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        called_at INTEGER NOT NULL DEFAULT (unixepoch()),
        duration_ms INTEGER,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        daemon_id TEXT,
        trace_id TEXT,
        parent_id TEXT
      );

      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_usage_server_tool ON usage_stats(server_name, tool_name);
      CREATE INDEX IF NOT EXISTS idx_usage_trace ON usage_stats(trace_id);
      CREATE INDEX IF NOT EXISTS idx_usage_daemon ON usage_stats(daemon_id);

      CREATE TABLE IF NOT EXISTS auth_tokens (
        server_name TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT DEFAULT 'Bearer',
        expires_at INTEGER,
        scope TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        server_name TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_secret TEXT,
        client_info_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS oauth_verifiers (
        server_name TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS oauth_discovery (
        server_name TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Partitioned by domain, PK included (#3034 review B5). Phases are stored as
      -- aliases, so every mcx project has impl/qa/review — a bare "name TEXT PRIMARY KEY"
      -- means the second domain to run "mcx phase install" overwrites the first domain's
      -- bundled_js. domain_id must be in the KEY, not merely in a column and a
      -- non-unique index.
      CREATE TABLE IF NOT EXISTS aliases (
        domain_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        description TEXT,
        file_path TEXT NOT NULL,
        alias_type TEXT NOT NULL DEFAULT 'freeform',
        input_schema_json TEXT,
        output_schema_json TEXT,
        bundled_js TEXT,
        source_hash TEXT,
        expires_at INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        scope TEXT,
        monitor_definitions_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (domain_id, name)
      );

      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_name TEXT NOT NULL,
        line TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_server_logs_lookup
        ON server_logs(server_name, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS mail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT,
        body TEXT,
        -- No REFERENCES mail(id) here, deliberately. It was this schema's only foreign
        -- key and PRAGMA foreign_keys is never set anywhere in this directory — SQLite
        -- defaults it OFF, so the clause enforced nothing and PRAGMA foreign_key_check
        -- would happily report the orphans it let through. Declaring a guarantee the
        -- database does not make is worse than not declaring it: it reads as a
        -- reply-integrity invariant that a cross-domain "mcx domain rm --force" breaks
        -- without a word (#3180).
        --
        -- NEW databases only, on purpose. Databases created before #3180 still declare
        -- the clause, and no migration step removes it: SQLite cannot drop a constraint
        -- in place, so that means rebuilding every user's mail table to delete a
        -- declaration with no runtime effect on any code path today. Whoever turns
        -- PRAGMA foreign_keys ON owns that rebuild — they have to audit the schema and
        -- the already-dangling reply_to rows anyway, and until then the two shapes
        -- behave identically. Do not "tidy" this into a migration on its own.
        reply_to INTEGER,
        read INTEGER NOT NULL DEFAULT 0,
        domain_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_mail_recipient
        ON mail(recipient, read, created_at);

      -- The domain-scoped replacement for this index is a v8 step, NOT an edit here.
      -- See the ladder below and the warning on applyV1Schema.

      CREATE TABLE IF NOT EXISTS notes (
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (server_name, tool_name)
      );

      -- alias_state's (repo_root, namespace, key) is the precedent domain_id generalizes:
      -- it was already a per-project partition, just keyed by a path instead of a domain.
      CREATE TABLE IF NOT EXISTS alias_state (
        domain_id INTEGER NOT NULL DEFAULT 0,
        repo_root TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (domain_id, repo_root, namespace, key)
      );

      CREATE TABLE IF NOT EXISTS session_metrics (
        session_id TEXT PRIMARY KEY,
        metrics_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id   TEXT PRIMARY KEY,
        name         TEXT,
        provider     TEXT NOT NULL DEFAULT 'claude',
        pid          INTEGER,
        pid_start_time INTEGER,
        state        TEXT NOT NULL DEFAULT 'connecting',
        model        TEXT,
        cwd          TEXT,
        worktree     TEXT,
        repo_root    TEXT,
        total_cost   REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        spawned_at   TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at     TEXT,
        transport    TEXT,
        domain_id    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_domain
        ON agent_sessions(domain_id, spawned_at DESC);

      CREATE TABLE IF NOT EXISTS spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        trace_flags TEXT NOT NULL DEFAULT '01',
        name TEXT NOT NULL,
        start_time_ms INTEGER NOT NULL,
        end_time_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'UNSET',
        attributes_json TEXT,
        events_json TEXT,
        daemon_id TEXT,
        exported_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_spans_exported ON spans(exported_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_spans_daemon ON spans(daemon_id);

      -- Same isolation bug as work_items: pr_number was globally unique, so two
      -- projects could not both have a PR #42. Keyed per domain now (#3034).
      -- pr_number = 0 is the per-domain repo-level poll watermark sentinel.
      CREATE TABLE IF NOT EXISTS copilot_comment_state (
        domain_id              INTEGER NOT NULL DEFAULT 0,
        pr_number              INTEGER NOT NULL,
        seen_comment_ids       TEXT NOT NULL DEFAULT '[]',
        seen_review_ids        TEXT NOT NULL DEFAULT '[]',
        seen_pr_comment_ids    TEXT NOT NULL DEFAULT '[]',
        seen_issue_comment_ids TEXT NOT NULL DEFAULT '[]',
        last_sticky_body_hash  TEXT,
        last_poll_ts           TEXT NOT NULL DEFAULT (datetime('now')),
        repo_poll_ts           TEXT,
        PRIMARY KEY (domain_id, pr_number)
      );
    `);
  }

  private setSchemaVersion(name: string, version: number): void {
    this.db
      .query<void, [string, number]>(
        "INSERT INTO schema_versions (name, version) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version",
      )
      .run(name, version);
  }

  // -- Tool cache --

  getCachedTools(server: string): ToolInfo[] {
    const rows = this.db
      .query<
        {
          server_name: string;
          tool_name: string;
          description: string | null;
          input_schema_json: string | null;
          signature: string | null;
        },
        [string]
      >(
        "SELECT server_name, tool_name, description, input_schema_json, signature FROM tool_cache WHERE server_name = ?",
      )
      .all(server);

    return rows.map((row) => ({
      name: row.tool_name,
      server: row.server_name,
      description: row.description ?? "",
      inputSchema: row.input_schema_json ? safeJsonParse(row.input_schema_json, {}) : {},
      signature: row.signature ?? undefined,
    }));
  }

  cacheTools(server: string, tools: ToolInfo[]): void {
    const txn = this.db.transaction(() => {
      this.db.run("DELETE FROM tool_cache WHERE server_name = ?", [server]);
      const insert = this.db.prepare(
        "INSERT INTO tool_cache (server_name, tool_name, description, input_schema_json, signature) VALUES (?, ?, ?, ?, ?)",
      );
      for (const tool of tools) {
        insert.run(server, tool.name, tool.description, JSON.stringify(tool.inputSchema), tool.signature ?? null);
      }
    });
    txn();
  }

  clearCache(server?: string): void {
    if (server) {
      this.db.run("DELETE FROM tool_cache WHERE server_name = ?", [server]);
    } else {
      this.db.run("DELETE FROM tool_cache");
    }
  }

  // -- Usage stats --

  private usageInsertCount = 0;

  recordUsage(
    server: string,
    tool: string,
    durationMs: number,
    success: boolean,
    error?: string,
    traceContext?: { daemonId?: string; traceId?: string; parentId?: string },
  ): void {
    this.db.run(
      `INSERT INTO usage_stats (server_name, tool_name, duration_ms, success, error_message, daemon_id, trace_id, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        server,
        tool,
        durationMs,
        success ? 1 : 0,
        error ?? null,
        traceContext?.daemonId ?? null,
        traceContext?.traceId ?? null,
        traceContext?.parentId ?? null,
      ],
    );
    this.maybeRunUsagePrune();
  }

  private maybeRunUsagePrune(): void {
    if (++this.usageInsertCount >= options.USAGE_PRUNE_INTERVAL) {
      this.usageInsertCount = 0;
      this.pruneUsageStats();
    }
  }

  pruneUsageStats(maxRows: number = options.USAGE_STATS_MAX_ROWS): number {
    const result = this.db.run(
      `DELETE FROM usage_stats WHERE id NOT IN (
        SELECT id FROM usage_stats ORDER BY called_at DESC, id DESC LIMIT ?
      )`,
      [maxRows],
    );
    return result.changes;
  }

  getUsageStats(): UsageStat[] {
    return this.db
      .query<
        {
          server_name: string;
          tool_name: string;
          call_count: number;
          total_duration_ms: number;
          success_count: number;
          error_count: number;
          last_called_at: number;
          last_error: string | null;
        },
        []
      >(
        `SELECT
          server_name, tool_name,
          COUNT(*) as call_count,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
          MAX(called_at) as last_called_at,
          (SELECT error_message FROM usage_stats u2
           WHERE u2.server_name = usage_stats.server_name
             AND u2.tool_name = usage_stats.tool_name
             AND u2.error_message IS NOT NULL
           ORDER BY u2.called_at DESC LIMIT 1) as last_error
        FROM usage_stats
        GROUP BY server_name, tool_name
        ORDER BY last_called_at DESC`,
      )
      .all()
      .map((row) => ({
        serverName: row.server_name,
        toolName: row.tool_name,
        callCount: row.call_count,
        totalDurationMs: row.total_duration_ms,
        successCount: row.success_count,
        errorCount: row.error_count,
        lastCalledAt: row.last_called_at,
        lastError: row.last_error,
      }));
  }

  // -- Daemon state --

  getState(key: string): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.run(
      "INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value],
    );
  }

  // -- Site watch cursor (mcx watch) --

  /** Last-seen `version` high-water mark for one watched thread, or null if unseen. */
  getSiteWatchCursor(site: string, thread: string): string | null {
    const row = this.db
      .query<{ last_version: string }, [string, string]>(
        "SELECT last_version FROM site_watch_cursor WHERE site = ? AND thread = ?",
      )
      .get(site, thread);
    return row?.last_version ?? null;
  }

  setSiteWatchCursor(site: string, thread: string, lastVersion: string): void {
    this.db.run(
      "INSERT INTO site_watch_cursor (site, thread, last_version, updated_at) VALUES (?, ?, ?, unixepoch()) " +
        "ON CONFLICT(site, thread) DO UPDATE SET last_version = excluded.last_version, updated_at = excluded.updated_at",
      [site, thread, lastVersion],
    );
  }

  // -- Budget config (#1587) --

  getBudgetConfig(): BudgetConfig {
    const raw = this.getState("budget_config");
    const defaults: BudgetConfig = {
      sessionCap: 3.0,
      sprintCap: 30.0,
      sprintWindowMs: 4 * 60 * 60 * 1000,
      quotaThresholds: [80, 95],
      quotaDeadband: 5,
    };
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw) as Partial<BudgetConfig>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  setBudgetConfig(partial: Partial<BudgetConfig>): void {
    const current = this.getBudgetConfig();
    const merged = { ...current, ...partial };
    this.setState("budget_config", JSON.stringify(merged));
  }

  // -- Auth tokens --

  getTokens(serverName: string): OAuthTokens | undefined {
    const row = this.db
      .query<
        {
          access_token: string;
          refresh_token: string | null;
          token_type: string;
          expires_at: number | null;
          scope: string | null;
        },
        [string]
      >("SELECT access_token, refresh_token, token_type, expires_at, scope FROM auth_tokens WHERE server_name = ?")
      .get(serverName);

    if (!row) return undefined;

    const tokens: OAuthTokens = {
      access_token: row.access_token,
      token_type: row.token_type,
    };
    if (row.refresh_token) tokens.refresh_token = row.refresh_token;
    if (row.scope) tokens.scope = row.scope;
    // Convert stored absolute ms timestamp to relative expires_in seconds
    if (row.expires_at) {
      const remainingSec = Math.floor((row.expires_at - Date.now()) / 1000);
      if (remainingSec > 0) tokens.expires_in = remainingSec;
    }
    return tokens;
  }

  /** Get the raw absolute expiry timestamp (ms) for a server's token, or null if no expiry / no token */
  getTokenExpiry(serverName: string): number | null {
    const row = this.db
      .query<{ expires_at: number | null }, [string]>("SELECT expires_at FROM auth_tokens WHERE server_name = ?")
      .get(serverName);
    return row?.expires_at ?? null;
  }

  saveTokens(serverName: string, tokens: OAuthTokens): void {
    // Convert relative expires_in to absolute ms timestamp for storage
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;
    this.db.run(
      `INSERT INTO auth_tokens (server_name, access_token, refresh_token, token_type, expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(server_name) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         token_type = excluded.token_type,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
      [
        serverName,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.token_type,
        expiresAt,
        tokens.scope ?? null,
      ],
    );
  }

  deleteTokens(serverName: string): void {
    this.db.run("DELETE FROM auth_tokens WHERE server_name = ?", [serverName]);
  }

  saveClientInfoAndTokens(serverName: string, info: OAuthClientInformationMixed, tokens: OAuthTokens): void {
    this.db.transaction(() => {
      this.saveClientInfo(serverName, info);
      this.saveTokens(serverName, tokens);
    })();
  }

  // -- OAuth client registration --

  getClientInfo(serverName: string): OAuthClientInformationMixed | undefined {
    const row = this.db
      .query<{ client_id: string; client_secret: string | null; client_info_json: string | null }, [string]>(
        "SELECT client_id, client_secret, client_info_json FROM oauth_clients WHERE server_name = ?",
      )
      .get(serverName);

    if (!row) return undefined;
    if (row.client_info_json) {
      const parsed = safeJsonParse<OAuthClientInformationMixed | null>(row.client_info_json, null);
      if (parsed) return parsed;
    }
    const info: OAuthClientInformationMixed = { client_id: row.client_id };
    if (row.client_secret) (info as Record<string, unknown>).client_secret = row.client_secret;
    return info;
  }

  saveClientInfo(serverName: string, info: OAuthClientInformationMixed): void {
    this.db.run(
      `INSERT INTO oauth_clients (server_name, client_id, client_secret, client_info_json, created_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(server_name) DO UPDATE SET
         client_id = excluded.client_id,
         client_secret = excluded.client_secret,
         client_info_json = excluded.client_info_json`,
      [
        serverName,
        info.client_id,
        ((info as Record<string, unknown>).client_secret as string) ?? null,
        JSON.stringify(info),
      ],
    );
  }

  deleteClientInfo(serverName: string): void {
    this.db.run("DELETE FROM oauth_clients WHERE server_name = ?", [serverName]);
  }

  // -- PKCE code verifier --

  getVerifier(serverName: string): string | undefined {
    const row = this.db
      .query<{ code_verifier: string }, [string]>("SELECT code_verifier FROM oauth_verifiers WHERE server_name = ?")
      .get(serverName);
    return row?.code_verifier;
  }

  saveVerifier(serverName: string, verifier: string): void {
    this.db.run(
      `INSERT INTO oauth_verifiers (server_name, code_verifier, created_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(server_name) DO UPDATE SET code_verifier = excluded.code_verifier`,
      [serverName, verifier],
    );
  }

  // -- OAuth discovery state --

  getDiscoveryState(serverName: string): OAuthDiscoveryState | undefined {
    const row = this.db
      .query<{ state_json: string }, [string]>("SELECT state_json FROM oauth_discovery WHERE server_name = ?")
      .get(serverName);
    if (!row) return undefined;
    return safeJsonParse<OAuthDiscoveryState | undefined>(row.state_json, undefined);
  }

  saveDiscoveryState(serverName: string, state: OAuthDiscoveryState): void {
    this.db.run(
      `INSERT INTO oauth_discovery (server_name, state_json, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(server_name) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      [serverName, JSON.stringify(state)],
    );
  }

  // -- Aliases --

  listAliases(domainId: number = NO_DOMAIN_ID): Array<{
    name: string;
    description: string;
    filePath: string;
    updatedAt: number;
    aliasType: AliasType;
    inputSchemaJson?: Record<string, unknown>;
    outputSchemaJson?: Record<string, unknown>;
    expiresAt?: number | null;
    runCount: number;
    lastRunAt: number | null;
    scope: string | null;
    monitorDefinitions?: MonitorAliasMetadata[];
  }> {
    this.maybeRunAliasPrune();
    return this.db
      .query<
        {
          name: string;
          description: string | null;
          file_path: string;
          updated_at: number;
          alias_type: string;
          input_schema_json: string | null;
          output_schema_json: string | null;
          expires_at: number | null;
          run_count: number;
          last_run_at: number | null;
          scope: string | null;
          monitor_definitions_json: string | null;
        },
        [number, number]
      >(
        "SELECT name, description, file_path, updated_at, alias_type, input_schema_json, output_schema_json, expires_at, run_count, last_run_at, scope, monitor_definitions_json FROM aliases WHERE domain_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY name",
      )
      .all(domainId, Date.now())
      .map((row) => ({
        name: row.name,
        description: row.description ?? "",
        filePath: row.file_path,
        updatedAt: row.updated_at,
        // dotw-todo no-db-ipc-cast: unguarded alias_type restore cast — fix in #2742
        aliasType: row.alias_type as AliasType,
        ...(row.input_schema_json ? { inputSchemaJson: safeJsonParse(row.input_schema_json, {}) } : {}),
        ...(row.output_schema_json ? { outputSchemaJson: safeJsonParse(row.output_schema_json, {}) } : {}),
        expiresAt: row.expires_at,
        runCount: row.run_count,
        lastRunAt: row.last_run_at,
        scope: row.scope,
        ...(row.monitor_definitions_json
          ? { monitorDefinitions: safeJsonParse(row.monitor_definitions_json, []) as MonitorAliasMetadata[] }
          : {}),
      }));
  }

  getAlias(
    name: string,
    domainId: number = NO_DOMAIN_ID,
  ):
    | {
        name: string;
        description: string;
        filePath: string;
        aliasType: AliasType;
        bundledJs?: string;
        sourceHash?: string;
        expiresAt?: number | null;
        runCount: number;
        lastRunAt: number | null;
        scope: string | null;
        monitorDefinitions?: MonitorAliasMetadata[];
      }
    | undefined {
    const row = this.db
      .query<
        {
          name: string;
          description: string | null;
          file_path: string;
          alias_type: string;
          bundled_js: string | null;
          source_hash: string | null;
          expires_at: number | null;
          run_count: number;
          last_run_at: number | null;
          scope: string | null;
          monitor_definitions_json: string | null;
        },
        [number, string]
      >(
        "SELECT name, description, file_path, alias_type, bundled_js, source_hash, expires_at, run_count, last_run_at, scope, monitor_definitions_json FROM aliases WHERE domain_id = ? AND name = ?",
      )
      .get(domainId, name);
    if (!row) return undefined;
    return {
      name: row.name,
      description: row.description ?? "",
      filePath: row.file_path,
      // dotw-todo no-db-ipc-cast: unguarded alias_type restore cast — fix in #2742
      aliasType: row.alias_type as AliasType,
      ...(row.bundled_js ? { bundledJs: row.bundled_js } : {}),
      ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
      expiresAt: row.expires_at,
      runCount: row.run_count,
      lastRunAt: row.last_run_at,
      scope: row.scope,
      ...(row.monitor_definitions_json
        ? { monitorDefinitions: safeJsonParse(row.monitor_definitions_json, []) as MonitorAliasMetadata[] }
        : {}),
    };
  }

  saveAlias(
    name: string,
    filePath: string,
    description?: string,
    aliasType: AliasType = "freeform",
    inputSchemaJson?: string,
    outputSchemaJson?: string,
    bundledJs?: string,
    sourceHash?: string,
    expiresAt?: number,
    scope?: string | null,
    scopeProvided = true,
    monitorDefinitionsJson?: string,
    monitorDefsProvided = true,
    domainId: number = NO_DOMAIN_ID,
  ): void {
    // If the caller is saving an ephemeral alias (expiresAt set), refuse to
    // overwrite an existing permanent alias (expires_at IS NULL). This prevents
    // auto-save hash collisions from clobbering user-curated aliases.
    if (expiresAt != null) {
      const existing = this.db
        .query<{ expires_at: number | null }, [number, string]>(
          "SELECT expires_at FROM aliases WHERE domain_id = ? AND name = ?",
        )
        .get(domainId, name);
      if (existing && existing.expires_at === null) {
        // Permanent alias exists — do not overwrite
        return;
      }
    }

    this.db.run(
      `INSERT INTO aliases (name, file_path, description, alias_type, input_schema_json, output_schema_json, bundled_js, source_hash, expires_at, scope, monitor_definitions_json, domain_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?14, unixepoch(), unixepoch())
       ON CONFLICT(domain_id, name) DO UPDATE SET
         file_path = excluded.file_path,
         description = excluded.description,
         alias_type = excluded.alias_type,
         input_schema_json = excluded.input_schema_json,
         output_schema_json = excluded.output_schema_json,
         bundled_js = excluded.bundled_js,
         source_hash = excluded.source_hash,
         expires_at = excluded.expires_at,
         scope = CASE WHEN ?12 = 1 THEN excluded.scope ELSE aliases.scope END,
         monitor_definitions_json = CASE WHEN ?13 = 1 THEN excluded.monitor_definitions_json ELSE aliases.monitor_definitions_json END,
         updated_at = unixepoch()`,
      [
        name, // ?1
        filePath, // ?2
        description ?? null, // ?3
        aliasType, // ?4
        inputSchemaJson ?? null, // ?5
        outputSchemaJson ?? null, // ?6
        bundledJs ?? null, // ?7
        sourceHash ?? null, // ?8
        expiresAt ?? null, // ?9
        scope ?? null, // ?10
        monitorDefinitionsJson ?? null, // ?11 — monitor_definitions_json value
        scopeProvided ? 1 : 0, // ?12 — scopeProvided flag for CASE WHEN
        monitorDefsProvided ? 1 : 0, // ?13 — monitorDefsProvided flag for CASE WHEN
        domainId, // ?14
      ],
    );
  }

  deleteAlias(name: string, domainId: number = NO_DOMAIN_ID): void {
    this.db.run("DELETE FROM aliases WHERE domain_id = ? AND name = ?", [domainId, name]);
  }

  /** Increment run_count and set last_run_at. Returns the new run count. */
  recordAliasRun(name: string, domainId: number = NO_DOMAIN_ID): number {
    const row = this.db
      .query<{ run_count: number }, [number, string]>(
        "UPDATE aliases SET run_count = run_count + 1, last_run_at = unixepoch() WHERE domain_id = ? AND name = ? RETURNING run_count",
      )
      .get(domainId, name);
    return row?.run_count ?? 0;
  }

  /** Reset the TTL on an ephemeral alias (called when re-run). */
  touchAliasExpiry(name: string, expiresAt: number, domainId: number = NO_DOMAIN_ID): void {
    this.db.run(
      "UPDATE aliases SET expires_at = ?, updated_at = unixepoch() WHERE domain_id = ? AND name = ? AND expires_at IS NOT NULL",
      [expiresAt, domainId, name],
    );
  }

  /** Delete ephemeral aliases past their TTL, cleaning up their files. */
  pruneExpiredAliases(): number {
    const now = Date.now();
    // Fetch file paths before deleting rows so we can clean up the files.
    // The SELECT and DELETE are intentionally not wrapped in a transaction —
    // all operations are synchronous (including unlinkSync), so no interleaving
    // can occur. If this is ever refactored to use async unlink, the SELECT and
    // DELETE must be wrapped in a transaction to prevent races.
    const expired = this.db
      .query<{ file_path: string }, [number]>(
        "SELECT file_path FROM aliases WHERE expires_at IS NOT NULL AND expires_at < ?",
      )
      .all(now);
    if (expired.length === 0) return 0;

    for (const row of expired) {
      try {
        unlinkSync(row.file_path);
      } catch {
        // file already gone, fine
      }
    }
    const result = this.db.run("DELETE FROM aliases WHERE expires_at IS NOT NULL AND expires_at < ?", [now]);
    return result.changes;
  }

  private maybeRunAliasPrune(): void {
    if (++this.aliasOpCount >= options.ALIAS_PRUNE_INTERVAL) {
      this.aliasOpCount = 0;
      this.pruneExpiredAliases();
    }
  }

  // -- Server logs (stderr persistence) --

  insertServerLog(serverName: string, line: string, timestampMs: number): void {
    this.db.run("INSERT INTO server_logs (server_name, line, timestamp_ms) VALUES (?, ?, ?)", [
      serverName,
      line,
      timestampMs,
    ]);
    // Prune to 500 rows per server, but only every LOG_PRUNE_INTERVAL inserts
    const count = (this.logInsertCount.get(serverName) ?? 0) + 1;
    if (count >= options.LOG_PRUNE_INTERVAL) {
      this.db.run(
        `DELETE FROM server_logs WHERE server_name = ? AND id NOT IN (
          SELECT id FROM server_logs WHERE server_name = ? ORDER BY timestamp_ms DESC LIMIT 500
        )`,
        [serverName, serverName],
      );
      this.logInsertCount.set(serverName, 0);
    } else {
      this.logInsertCount.set(serverName, count);
    }
  }

  getServerLogs(serverName: string, limit?: number, sinceMs?: number): Array<{ line: string; timestampMs: number }> {
    const conditions = ["server_name = ?"];
    const params: (string | number)[] = [serverName];

    if (sinceMs !== undefined) {
      conditions.push("timestamp_ms > ?");
      params.push(sinceMs);
    }

    const where = conditions.join(" AND ");
    const limitClause = limit ? " LIMIT ?" : "";
    if (limit) params.push(limit);

    // `id` tiebreaker: lines from one stderr chunk share a Date.now() ms, so
    // ordering on timestamp_ms alone is nondeterministic within a chunk (#2769).
    return this.db
      .query<{ line: string; timestamp_ms: number }, (string | number)[]>(
        `SELECT line, timestamp_ms FROM server_logs WHERE ${where} ORDER BY timestamp_ms ASC, id ASC${limitClause}`,
      )
      .all(...params)
      .map((row) => ({ line: row.line, timestampMs: row.timestamp_ms }));
  }

  /**
   * Most recent `limit` log lines for a server, returned in chronological
   * (oldest→newest) order. Unlike {@link getServerLogs} — which takes the
   * OLDEST N — this returns the TAIL, i.e. the lines a spawn-failure postmortem
   * actually wants (#2769). Mirrors the in-memory ring's newest-N semantics so
   * `mcx logs <id>` reads the same end whether the session is live or dead.
   */
  getRecentServerLogs(serverName: string, limit?: number): Array<{ line: string; timestampMs: number }> {
    const limitClause = limit ? " LIMIT ?" : "";
    const params: (string | number)[] = [serverName];
    if (limit) params.push(limit);

    const rows = this.db
      .query<{ line: string; timestamp_ms: number }, (string | number)[]>(
        `SELECT line, timestamp_ms FROM server_logs WHERE server_name = ? ORDER BY timestamp_ms DESC, id DESC${limitClause}`,
      )
      .all(...params)
      .map((row) => ({ line: row.line, timestampMs: row.timestamp_ms }));
    return rows.reverse();
  }

  clearServerLogs(serverName?: string): void {
    if (serverName) {
      this.db.run("DELETE FROM server_logs WHERE server_name = ?", [serverName]);
    } else {
      this.db.run("DELETE FROM server_logs");
    }
  }

  // -- Mail (domain-partitioned, #3038) --
  //
  // `domainId` is the **required first parameter** of every method here, deliberately
  // not a trailing `domainId: number = NO_DOMAIN_ID`. A defaulted partition key compiles
  // at every call site that has not thought about the partition, which is how a column
  // ends up present with no writer; a required leading one makes tsc enumerate them.
  //
  // Every read predicates on `domain_id = ?`. There is no code path that omits it, so
  // there is no path that degrades to a cross-partition read. Resolution of *which*
  // domain lives in `mail-domain.ts`; this layer only enforces that one was supplied.

  insertMail(
    domainId: number,
    sender: string,
    recipient: string,
    subject?: string,
    body?: string,
    replyTo?: number,
  ): number {
    const result = this.db.run(
      "INSERT INTO mail (domain_id, sender, recipient, subject, body, reply_to) VALUES (?, ?, ?, ?, ?, ?)",
      [domainId, sender, recipient, subject ?? null, body ?? null, replyTo ?? null],
    );
    this.maybeRunMailPrune();
    return Number(result.lastInsertRowid);
  }

  readMail(domainId: number, recipient?: string, unreadOnly?: boolean, limit?: number): MailMessage[] {
    this.maybeRunMailPrune();

    const conditions: string[] = ["domain_id = ?"];
    const params: (string | number)[] = [domainId];

    if (recipient) {
      conditions.push("(recipient = ? OR recipient = '*')");
      params.push(recipient);
    }
    if (unreadOnly) {
      conditions.push("read = 0");
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limitClause = limit ? " LIMIT ?" : "";
    if (limit) params.push(limit);

    return this.db
      .query<RawMailRow, (string | number)[]>(`${MAIL_SELECT} ${where} ORDER BY created_at DESC${limitClause}`)
      .all(...params)
      .map(toMailMessage);
  }

  /**
   * Fetch one message **within a partition**. A message id from another domain resolves
   * to `undefined`, exactly as a nonexistent one does — the caller cannot distinguish
   * "not yours" from "not there", which is the point: message ids are sequential and
   * probing them must not report on another domain's traffic.
   */
  getMailById(id: number, domainId: number): MailMessage | undefined {
    const row = this.db
      .query<RawMailRow, [number, number]>(`${MAIL_SELECT} WHERE id = ? AND domain_id = ?`)
      .get(id, domainId);
    return row ? toMailMessage(row) : undefined;
  }

  getNextUnread(domainId: number, recipient?: string): MailMessage | undefined {
    const conditions = ["domain_id = ?", "read = 0"];
    const params: (string | number)[] = [domainId];

    if (recipient) {
      conditions.push("(recipient = ? OR recipient = '*')");
      params.push(recipient);
    }

    const where = conditions.join(" AND ");
    const row = this.db
      .query<RawMailRow, (string | number)[]>(`${MAIL_SELECT} WHERE ${where} ORDER BY created_at ASC LIMIT 1`)
      .get(...params);
    return row ? toMailMessage(row) : undefined;
  }

  /** Returns true when a row in this partition was marked read; false for another domain's id. */
  markMailRead(id: number, domainId: number): boolean {
    return this.db.run("UPDATE mail SET read = 1 WHERE id = ? AND domain_id = ?", [id, domainId]).changes > 0;
  }

  /**
   * Delete read messages older than ttlMs. Called opportunistically.
   *
   * Deliberately **not** domain-scoped: this is the TTL janitor, not a read. It moves no
   * bytes across a partition boundary and exposes nothing to anyone — scoping it would
   * instead mean a partition whose last caller went away never gets swept.
   */
  pruneExpiredMail(ttlMs = options.MAIL_TTL_MS): number {
    const cutoff = formatSqliteDatetime(Date.now() - ttlMs);
    const result = this.db.run("DELETE FROM mail WHERE read = 1 AND created_at < ?", [cutoff]);
    return result.changes;
  }

  private maybeRunMailPrune(): void {
    this.mailOpCount++;
    if (this.mailOpCount >= options.MAIL_PRUNE_INTERVAL) {
      this.mailOpCount = 0;
      this.pruneExpiredMail();
    }
  }

  // -- Agent sessions --

  upsertSession(session: {
    sessionId: string;
    name?: string;
    provider?: string;
    pid?: number;
    pidStartTime?: number;
    state?: string;
    model?: string;
    cwd?: string;
    worktree?: string;
    repoRoot?: string;
    claudeSessionId?: string;
    transport?: "ws" | "stdio";
    /**
     * Domain that owns this session (#3039), resolved daemon-side from the spawn
     * directory. Omit on a follow-up upsert — every other field here is COALESCEd
     * so a partial update cannot erase what a previous one set, and `domain_id`
     * has to behave the same way. It is `NOT NULL DEFAULT 0`, so the *stored*
     * value is never null; the bind is nullable purely to mean "not supplied",
     * which is why the parameter is COALESCEd on both branches rather than being
     * allowed to write a 0 over a resolved domain.
     */
    domainId?: number;
  }): void {
    this.db.run(
      `INSERT INTO agent_sessions (session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root, claude_session_id, transport, domain_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?13, 0))
       ON CONFLICT(session_id) DO UPDATE SET
         -- CASE, not COALESCE: the spawn-side idiom in all five workers is
         -- \`typeof args.domainId === "number" ? args.domainId : NO_DOMAIN_ID\`, which
         -- turns "unknown" into a literal 0 that COALESCE cannot tell from an
         -- intentional write. The invariant that matters is "0 never overwrites a
         -- resolved domain", and this is the only place it can be enforced rather
         -- than relied upon. Re-homing to 0 is done by an explicit UPDATE
         -- (deleteDomain), never by an upsert.
         domain_id = CASE WHEN ?13 IS NULL OR ?13 = 0 THEN agent_sessions.domain_id ELSE ?13 END,
         name = COALESCE(excluded.name, agent_sessions.name),
         provider = COALESCE(excluded.provider, agent_sessions.provider),
         pid = COALESCE(excluded.pid, agent_sessions.pid),
         pid_start_time = COALESCE(excluded.pid_start_time, agent_sessions.pid_start_time),
         state = COALESCE(excluded.state, agent_sessions.state),
         model = COALESCE(excluded.model, agent_sessions.model),
         cwd = COALESCE(excluded.cwd, agent_sessions.cwd),
         worktree = COALESCE(excluded.worktree, agent_sessions.worktree),
         repo_root = COALESCE(excluded.repo_root, agent_sessions.repo_root),
         claude_session_id = COALESCE(excluded.claude_session_id, agent_sessions.claude_session_id),
         transport = COALESCE(excluded.transport, agent_sessions.transport)`,
      [
        session.sessionId,
        session.name ?? null,
        session.provider ?? "claude",
        session.pid ?? null,
        session.pidStartTime ?? null,
        session.state ?? "connecting",
        session.model ?? null,
        session.cwd ?? null,
        session.worktree ?? null,
        session.repoRoot ?? null,
        session.claudeSessionId ?? null,
        session.transport ?? null,
        session.domainId ?? null, // ?13 — null means "not supplied", never "domain 0"
      ],
    );
  }

  updateSessionState(sessionId: string, state: string): void {
    this.db.run("UPDATE agent_sessions SET state = ? WHERE session_id = ?", [state, sessionId]);
  }

  updateSessionCost(sessionId: string, cost: number, tokens: number): void {
    this.db.run("UPDATE agent_sessions SET total_cost = ?, total_tokens = ? WHERE session_id = ?", [
      cost,
      tokens,
      sessionId,
    ]);
  }

  endSession(sessionId: string): void {
    this.db.run("UPDATE agent_sessions SET state = 'ended', ended_at = datetime('now') WHERE session_id = ?", [
      sessionId,
    ]);
  }

  getSession(sessionId: string): AgentSessionRow | null {
    const row = this.db
      .query<RawSessionRow, [string]>(
        "SELECT session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root, total_cost, total_tokens, spawned_at, ended_at, claude_session_id, transport, domain_id FROM agent_sessions WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? toSessionRow(row) : null;
  }

  listSessions(active?: boolean): AgentSessionRow[] {
    const where = active === true ? " WHERE ended_at IS NULL" : active === false ? " WHERE ended_at IS NOT NULL" : "";
    return this.db
      .query<RawSessionRow, []>(
        `SELECT session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root, total_cost, total_tokens, spawned_at, ended_at, claude_session_id, transport, domain_id FROM agent_sessions${where} ORDER BY spawned_at DESC`,
      )
      .all()
      .map(toSessionRow);
  }

  sprintCostSince(cutoffMs: number): { totalCost: number; sessionCount: number } {
    const cutoff = formatSqliteDatetime(cutoffMs);
    const row = this.db
      .query<{ total_cost: number; cnt: number }, [string]>(
        "SELECT COALESCE(SUM(total_cost), 0) AS total_cost, COUNT(*) AS cnt FROM agent_sessions WHERE spawned_at >= ?",
      )
      .get(cutoff);
    return { totalCost: row?.total_cost ?? 0, sessionCount: row?.cnt ?? 0 };
  }

  pruneOldSessions(maxAgeDays = 30): number {
    const cutoff = formatSqliteDatetime(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const result = this.db.run("DELETE FROM agent_sessions WHERE ended_at IS NOT NULL AND ended_at < ?", [cutoff]);
    return result.changes;
  }

  // -- Spans (export buffer) --

  private spanInsertCount = 0;

  recordSpan(span: Span, daemonId?: string): void {
    this.db.run(
      `INSERT INTO spans (trace_id, span_id, parent_span_id, trace_flags, name,
        start_time_ms, end_time_ms, duration_ms, status, attributes_json, events_json, daemon_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId ?? null,
        span.traceFlags,
        span.name,
        span.startTimeMs,
        span.endTimeMs,
        span.durationMs,
        span.status,
        Object.keys(span.attributes).length > 0 ? JSON.stringify(span.attributes) : null,
        span.events.length > 0 ? JSON.stringify(span.events) : null,
        daemonId ?? null,
      ],
    );
    if (++this.spanInsertCount >= options.SPAN_PRUNE_INTERVAL) {
      this.spanInsertCount = 0;
      // Auto-prune exported spans older than 1 hour
      this.pruneSpans(Date.now() - 3600_000);
      // Hard cap: prune oldest rows regardless of export status
      this.pruneSpansByRowCount();
    }
  }

  getSpans(opts?: { since?: number; limit?: number; unexported?: boolean }): SpanRow[] {
    const conditions: string[] = [];
    const params: number[] = [];

    if (opts?.since !== undefined) {
      conditions.push("start_time_ms >= ?");
      params.push(opts.since);
    }
    if (opts?.unexported) {
      conditions.push("exported_at IS NULL");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 1000;

    const allParams = [...params, limit];
    const rows = this.db
      .prepare<
        {
          id: number;
          trace_id: string;
          span_id: string;
          parent_span_id: string | null;
          trace_flags: string;
          name: string;
          start_time_ms: number;
          end_time_ms: number;
          duration_ms: number;
          status: string;
          attributes_json: string | null;
          events_json: string | null;
          daemon_id: string | null;
          exported_at: number | null;
        },
        number[]
      >(
        `SELECT id, trace_id, span_id, parent_span_id, trace_flags, name,
          start_time_ms, end_time_ms, duration_ms, status, attributes_json,
          events_json, daemon_id, exported_at
         FROM spans ${where} ORDER BY start_time_ms DESC LIMIT ?`,
      )
      .all(...allParams);

    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      traceFlags: row.trace_flags,
      name: row.name,
      startTimeMs: row.start_time_ms,
      endTimeMs: row.end_time_ms,
      durationMs: row.duration_ms,
      status: row.status,
      attributes: row.attributes_json ? safeJsonParse(row.attributes_json, {}) : {},
      events: row.events_json ? safeJsonParse(row.events_json, []) : [],
      daemonId: row.daemon_id,
      exportedAt: row.exported_at,
    }));
  }

  /** Query spans with flexible filters. Returns matching spans (no exported_at). */
  querySpans(opts?: {
    daemonId?: string;
    traceId?: string;
    server?: string;
    tool?: string;
    status?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
    afterId?: number;
  }): Omit<SpanRow, "exportedAt">[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.daemonId) {
      conditions.push("daemon_id = ?");
      params.push(opts.daemonId);
    }
    if (opts?.traceId) {
      conditions.push("trace_id = ?");
      params.push(opts.traceId);
    }
    if (opts?.server) {
      conditions.push("name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(opts.server)}%`);
    }
    if (opts?.tool) {
      // Tool names appear after the last colon in structured span names (e.g. "tool_call:server:tool")
      conditions.push("name LIKE ? ESCAPE '\\'");
      params.push(`%:${escapeLike(opts.tool)}`);
    }
    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.sinceMs !== undefined) {
      conditions.push("start_time_ms >= ?");
      params.push(opts.sinceMs);
    }
    if (opts?.untilMs !== undefined) {
      conditions.push("start_time_ms <= ?");
      params.push(opts.untilMs);
    }
    if (opts?.afterId !== undefined) {
      conditions.push("id < ?");
      params.push(opts.afterId);
    }

    const limit = Math.min(Math.max(1, opts?.limit ?? 100), 1000);
    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, trace_id, span_id, parent_span_id, trace_flags, name,
          start_time_ms, end_time_ms, duration_ms, status, attributes_json,
          events_json, daemon_id
         FROM spans ${where} ORDER BY start_time_ms DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Array<{
      id: number;
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
      trace_flags: string;
      name: string;
      start_time_ms: number;
      end_time_ms: number;
      duration_ms: number;
      status: string;
      attributes_json: string | null;
      events_json: string | null;
      daemon_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      traceFlags: row.trace_flags,
      name: row.name,
      startTimeMs: row.start_time_ms,
      endTimeMs: row.end_time_ms,
      durationMs: row.duration_ms,
      status: row.status,
      attributes: row.attributes_json ? safeJsonParse(row.attributes_json, {}) : {},
      events: row.events_json ? safeJsonParse(row.events_json, []) : [],
      daemonId: row.daemon_id,
    }));
  }

  /** Get all spans for a specific trace, ordered by start time ASC. */
  getTraceSpans(traceId: string): Omit<SpanRow, "exportedAt">[] {
    const rows = this.db
      .prepare(
        `SELECT id, trace_id, span_id, parent_span_id, trace_flags, name,
          start_time_ms, end_time_ms, duration_ms, status, attributes_json,
          events_json, daemon_id
         FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`,
      )
      .all(traceId) as Array<{
      id: number;
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
      trace_flags: string;
      name: string;
      start_time_ms: number;
      end_time_ms: number;
      duration_ms: number;
      status: string;
      attributes_json: string | null;
      events_json: string | null;
      daemon_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      traceFlags: row.trace_flags,
      name: row.name,
      startTimeMs: row.start_time_ms,
      endTimeMs: row.end_time_ms,
      durationMs: row.duration_ms,
      status: row.status,
      attributes: row.attributes_json ? safeJsonParse(row.attributes_json, {}) : {},
      events: row.events_json ? safeJsonParse(row.events_json, []) : [],
      daemonId: row.daemon_id,
    }));
  }

  /** List distinct daemon instances with span counts and time ranges. */
  listDaemons(): Array<{ daemonId: string; spanCount: number; earliestMs: number; latestMs: number }> {
    const rows = this.db
      .prepare(
        `SELECT daemon_id, COUNT(*) as span_count, MIN(start_time_ms) as earliest_ms, MAX(start_time_ms) as latest_ms
         FROM spans WHERE daemon_id IS NOT NULL GROUP BY daemon_id ORDER BY latest_ms DESC`,
      )
      .all() as Array<{ daemon_id: string; span_count: number; earliest_ms: number; latest_ms: number }>;

    return rows.map((r) => ({
      daemonId: r.daemon_id,
      spanCount: r.span_count,
      earliestMs: r.earliest_ms,
      latestMs: r.latest_ms,
    }));
  }

  markSpansExported(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const now = Date.now();
    const result = this.db.run(`UPDATE spans SET exported_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
    return result.changes;
  }

  pruneSpans(beforeMs?: number): number {
    if (beforeMs !== undefined) {
      const result = this.db.run("DELETE FROM spans WHERE exported_at IS NOT NULL AND exported_at < ?", [beforeMs]);
      return result.changes;
    }
    // Default: prune all exported spans
    const result = this.db.run("DELETE FROM spans WHERE exported_at IS NOT NULL");
    return result.changes;
  }

  /** Hard cap: delete oldest span rows regardless of export status. */
  pruneSpansByRowCount(maxRows: number = options.SPANS_MAX_ROWS): number {
    const result = this.db.run(
      `DELETE FROM spans WHERE id NOT IN (
        SELECT id FROM spans ORDER BY start_time_ms DESC, id DESC LIMIT ?
      )`,
      [maxRows],
    );
    return result.changes;
  }

  // -- Notes (per-tool annotations) --

  setNote(serverName: string, toolName: string, note: string): void {
    this.db.run(
      `INSERT INTO notes (server_name, tool_name, note, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(server_name, tool_name) DO UPDATE SET
         note = excluded.note, updated_at = excluded.updated_at`,
      [serverName, toolName, note],
    );
  }

  getNote(serverName: string, toolName: string): string | undefined {
    const row = this.db
      .query<{ note: string }, [string, string]>("SELECT note FROM notes WHERE server_name = ? AND tool_name = ?")
      .get(serverName, toolName);
    return row?.note;
  }

  listNotes(): Array<{ serverName: string; toolName: string; note: string; updatedAt: number }> {
    return this.db
      .query<{ server_name: string; tool_name: string; note: string; updated_at: number }, []>(
        "SELECT server_name, tool_name, note, updated_at FROM notes ORDER BY server_name, tool_name",
      )
      .all()
      .map((row) => ({
        serverName: row.server_name,
        toolName: row.tool_name,
        note: row.note,
        updatedAt: row.updated_at,
      }));
  }

  deleteNote(serverName: string, toolName: string): boolean {
    const result = this.db.run("DELETE FROM notes WHERE server_name = ? AND tool_name = ?", [serverName, toolName]);
    return result.changes > 0;
  }

  // -- Alias state --
  //
  // `domainId` is REQUIRED on all four, with no default (#3040 review R1). It was
  // optional, and that is precisely how the third column-present/writer-absent bug in
  // this arc hid: an optional parameter let `PhaseStateStore` — which declared only
  // three — still be structurally satisfied by McxDb, so `_work_items`
  // phase_state_* silently wrote domain 0 while `ctx.state` wrote a real domain. Same
  // repo_root, same `workitem:<id>` namespace, different rows, and tsc said nothing.
  // A partition key a caller can omit is prose; one the compiler demands is a function.

  getAliasState(repoRoot: string, namespace: string, key: string, domainId: number): unknown {
    const row = this.db
      .query<{ value_json: string }, [number, string, string, string]>(
        "SELECT value_json FROM alias_state WHERE domain_id = ? AND repo_root = ? AND namespace = ? AND key = ?",
      )
      .get(domainId, repoRoot, namespace, key);
    if (!row) return undefined;
    return safeParseStateValue(row.value_json, `${repoRoot}/${namespace}/${key}`);
  }

  setAliasState(repoRoot: string, namespace: string, key: string, value: unknown, domainId: number): void {
    // `undefined` would serialise to the string `"null"` and then readers
    // could not tell "set to null" from "never set" — reject it up front.
    if (value === undefined) {
      throw new Error("alias state value cannot be undefined; use delete(key) to remove a key");
    }
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error("alias state value is not JSON-serialisable");
    }
    // Guard against an alias persisting an arbitrarily large blob — both the
    // daemon heap and every subsequent listAliasState() response would swell.
    if (Buffer.byteLength(json, "utf-8") > ALIAS_STATE_MAX_VALUE_BYTES) {
      throw new Error(`alias state value exceeds max size of ${ALIAS_STATE_MAX_VALUE_BYTES} bytes`);
    }
    this.db.run(
      `INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(domain_id, repo_root, namespace, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [domainId, repoRoot, namespace, key, json],
    );
  }

  deleteAliasState(repoRoot: string, namespace: string, key: string, domainId: number): boolean {
    const result = this.db.run(
      "DELETE FROM alias_state WHERE domain_id = ? AND repo_root = ? AND namespace = ? AND key = ?",
      [domainId, repoRoot, namespace, key],
    );
    return result.changes > 0;
  }

  listAliasState(repoRoot: string, namespace: string, domainId: number): Record<string, unknown> {
    const rows = this.db
      .query<{ key: string; value_json: string }, [number, string, string]>(
        "SELECT key, value_json FROM alias_state WHERE domain_id = ? AND repo_root = ? AND namespace = ?",
      )
      .all(domainId, repoRoot, namespace);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const parsed = safeParseStateValue(row.value_json, `${repoRoot}/${namespace}/${row.key}`);
      if (parsed !== undefined) out[row.key] = parsed;
    }
    return out;
  }

  // -- Copilot comment state (#1578) --
  //
  // Partitioned by domain (#3034): pr_number alone was globally unique, so two
  // projects could not both track PR #42. Every accessor takes a trailing
  // `domainId` that defaults to NO_DOMAIN_ID, so callers that have not been
  // domain-scoped yet keep operating on the unassigned partition.

  // `query()` rather than `prepare()`: bun caches the prepared statement, and these run
  // inside the copilot poll loop.
  private getCopilotColumn(column: string, prNumber: number, domainId: number): unknown {
    return this.db
      .query<{ v: unknown }, [number, number]>(
        `SELECT ${column} AS v FROM copilot_comment_state WHERE domain_id = ? AND pr_number = ?`,
      )
      .get(domainId, prNumber)?.v;
  }

  private setCopilotColumn(column: string, prNumber: number, value: string | null, domainId: number): void {
    this.db
      .query<void, [number, number, string | null]>(
        `INSERT INTO copilot_comment_state (domain_id, pr_number, ${column}, last_poll_ts)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(domain_id, pr_number) DO UPDATE SET
           ${column} = excluded.${column},
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(domainId, prNumber, value);
  }

  getSeenCommentIds(prNumber: number, domainId: number = NO_DOMAIN_ID): number[] {
    const raw = this.getCopilotColumn("seen_comment_ids", prNumber, domainId);
    return typeof raw === "string" ? safeJsonParse<number[]>(raw, []) : [];
  }

  updateSeenCommentIds(prNumber: number, ids: number[], domainId: number = NO_DOMAIN_ID): void {
    this.setCopilotColumn("seen_comment_ids", prNumber, JSON.stringify(ids), domainId);
  }

  // -- Review IDs (#1579) --

  getSeenReviewIds(prNumber: number, domainId: number = NO_DOMAIN_ID): number[] {
    const raw = this.getCopilotColumn("seen_review_ids", prNumber, domainId);
    return typeof raw === "string" ? safeJsonParse<number[]>(raw, []) : [];
  }

  updateSeenReviewIds(prNumber: number, ids: number[], domainId: number = NO_DOMAIN_ID): void {
    this.setCopilotColumn("seen_review_ids", prNumber, JSON.stringify(ids), domainId);
  }

  // -- Top-level PR comment IDs (#1579) --

  getSeenPRCommentIds(prNumber: number, domainId: number = NO_DOMAIN_ID): number[] {
    const raw = this.getCopilotColumn("seen_pr_comment_ids", prNumber, domainId);
    return typeof raw === "string" ? safeJsonParse<number[]>(raw, []) : [];
  }

  updateSeenPRCommentIds(prNumber: number, ids: number[], domainId: number = NO_DOMAIN_ID): void {
    this.setCopilotColumn("seen_pr_comment_ids", prNumber, JSON.stringify(ids), domainId);
  }

  // -- Issue comment IDs (#1579) --

  getSeenIssueCommentIds(issueNumber: number, domainId: number = NO_DOMAIN_ID): number[] {
    const raw = this.getCopilotColumn("seen_issue_comment_ids", issueNumber, domainId);
    return typeof raw === "string" ? safeJsonParse<number[]>(raw, []) : [];
  }

  updateSeenIssueCommentIds(issueNumber: number, ids: number[], domainId: number = NO_DOMAIN_ID): void {
    this.setCopilotColumn("seen_issue_comment_ids", issueNumber, JSON.stringify(ids), domainId);
  }

  // -- Sticky body hash (#1579) --

  getStickyBodyHash(prNumber: number, domainId: number = NO_DOMAIN_ID): string | null {
    const raw = this.getCopilotColumn("last_sticky_body_hash", prNumber, domainId);
    return typeof raw === "string" ? raw : null;
  }

  updateStickyBodyHash(prNumber: number, hash: string | null, domainId: number = NO_DOMAIN_ID): void {
    this.setCopilotColumn("last_sticky_body_hash", prNumber, hash, domainId);
  }

  deleteCopilotCommentState(workItemNumber: number, domainId: number = NO_DOMAIN_ID): boolean {
    if (workItemNumber === 0) return false;
    const result = this.db.run("DELETE FROM copilot_comment_state WHERE domain_id = ? AND pr_number = ?", [
      domainId,
      workItemNumber,
    ]);
    return result.changes > 0;
  }

  getLastRepoPollTs(domainId: number = NO_DOMAIN_ID): string | null {
    const row = this.db
      .query<{ repo_poll_ts: string | null }, [number]>(
        "SELECT repo_poll_ts FROM copilot_comment_state WHERE domain_id = ? AND pr_number = 0",
      )
      .get(domainId);
    return row?.repo_poll_ts ?? null;
  }

  updateLastRepoPollTs(isoTs: string, domainId: number = NO_DOMAIN_ID): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (domain_id, pr_number, repo_poll_ts)
         VALUES (?, 0, ?)
         ON CONFLICT(domain_id, pr_number) DO UPDATE SET
           repo_poll_ts = excluded.repo_poll_ts`,
      )
      .run(domainId, isoTs);
  }

  // -- Domains (#3034) --

  /**
   * The domain already registered at `[host:]path`, matched the way
   * `idx_domains_location` matches: `COALESCE(host,'')`, because SQLite treats NULLs in a
   * UNIQUE index as distinct and the index is the actual enforcement. A hand-rolled
   * `d.host === host` filter agrees with it for every value `isValidDomainHost` admits and
   * disagrees for `''` — so it is spelled once, here, in the index's own terms.
   */
  private getDomainByLocation(host: string | null, path: string): Domain | null {
    const row = this.db
      .query<RawDomainRow, [string | null, string]>(
        `SELECT id, name, host, path, created_at FROM domains
          WHERE COALESCE(host, '') = COALESCE(?, '') AND path = ?`,
      )
      .get(host, path);
    return row ? toDomain(row) : null;
  }

  /**
   * Register a domain. Throws a {@link DomainConflictError} on a duplicate name or a
   * duplicate `[host:]path` location.
   *
   * A **local** path is canonicalized (absolute, symlinks resolved) so the resolver
   * compares like with like — #1526 and #1684 were both this bug in other tables.
   * A **host-bound** path is stored verbatim: it names a directory on another machine,
   * so normalizing it against this filesystem is meaningless and `~/work` there is that
   * host's home, not ours.
   *
   * The collision check and the INSERT are ONE transaction (#3210). They used to be two
   * steps in `handlers/domain.ts`, which is the same TOCTOU `deleteDomain` was fixed for
   * in #3180: two writers both pass the check, and the loser gets a bare
   * `SQLITE_CONSTRAINT_UNIQUE` from the index instead of the named-conflict message the
   * check exists to produce — the raw error it was written to prevent. `.immediate()`,
   * not the default DEFERRED, because this body reads and then writes: under WAL a
   * DEFERRED transaction takes the write lock at the first write, and a writer that
   * committed in between invalidates the read snapshot, failing with
   * `SQLITE_BUSY_SNAPSHOT` — which `busy_timeout` does not retry.
   */
  createDomain(name: string, path: string, host: string | null = null): Domain {
    if (!isValidDomainName(name)) {
      throw new Error(`invalid domain name "${name}": must be alphanumeric, hyphens, or underscores`);
    }
    // The local/remote branch is `host === null`, so an empty-ish host took the REMOTE
    // path — stored verbatim, never canonicalized, absoluteness never checked — while
    // COALESCE(host,'') in idx_domains_location treated it as LOCAL for uniqueness. It
    // was simultaneously both (#3034 review Y6). Use null for local; anything else must
    // be a real hostname.
    if (host !== null && !isValidDomainHost(host)) {
      throw new Error(`invalid domain host ${JSON.stringify(host)}: use null for a local domain`);
    }
    const storedPath = host === null ? canonicalizeDomainPath(path) : path;
    const domain = this.db
      .transaction(() => {
        const byName = this.getDomainByName(name);
        if (byName) throw new DomainConflictError("name", name, byName);
        const byLocation = this.getDomainByLocation(host, storedPath);
        if (byLocation) {
          throw new DomainConflictError("location", formatDomainLocation({ host, path: storedPath }), byLocation);
        }
        const row = this.db
          .query<RawDomainRow, [string, string | null, string]>(
            `INSERT INTO domains (name, host, path, created_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             RETURNING id, name, host, path, created_at`,
          )
          .get(name, host, storedPath);
        if (!row) throw new Error(`failed to create domain "${name}"`);
        return toDomain(row);
      })
      .immediate();
    // Registering a domain ADOPTS the sessions already standing in it. Without this,
    // creating a domain over a directory that has running sessions instantly hides
    // them: their rows stay at `domain_id = 0`, and an exact-equality domain filter
    // excludes 0. The operator sees an empty `mcx claude ls` in the very directory
    // they just registered, with live children still attached.
    this.adoptSessionsIntoDomains();
    return domain;
  }

  /**
   * Assign a domain to every session row still carrying `NO_DOMAIN_ID`, resolved from
   * the directory it was spawned in.
   *
   * This is the upgrade path, and it is not optional. `importLegacyState` turns a
   * user's `~/.mcp-cli/scopes/` sidecars into domain rows automatically on the first
   * daemon start after the new schema — no flag, no prompt. Every session that existed
   * before that moment has `domain_id = 0`, and `matchesDomain` is exact equality, so
   * without a backfill the upgrade silently empties `mcx claude ls` for anyone who ever
   * ran `mcx scope`. Worse than the empty list: `mcx claude bye --all` also
   * sees nothing, so the operator can shut the daemon down believing the box is clean
   * while live children are still running.
   *
   * Resolution is `cwd`, then `repo_root` — most specific first, the same order
   * `resolveSpawnDomainId` uses, so a backfilled row lands where a fresh spawn would.
   * Rows whose directory is outside every domain stay at the sentinel, which is the
   * true answer for them rather than a guess.
   *
   * Only LIVE rows (`ended_at IS NULL`) are adopted — see the SQL comment below.
   *
   * Returns the number of rows adopted. Idempotent: a second call matches nothing,
   * because only unassigned live rows are considered.
   *
   * NOTE: this fixes the *database*. Workers hold `SessionConfig.domainId` in memory,
   * so a domain registered while a session is live is not reflected in that worker
   * until the daemon restarts and `restoreSessions` re-reads these rows. That is
   * sufficient today because the only caller that creates domains at runtime is the
   * startup import (which runs before sessions are restored); `mcx domain rm`/`add`
   * (#3035) will need to push the adoption into the workers as well.
   */
  adoptSessionsIntoDomains(): number {
    const domains = this.listDomains();
    if (domains.length === 0) return 0;

    const rows = this.db
      .query<{ session_id: string; cwd: string | null; repo_root: string | null }, [number]>(
        // LIVE rows only. An ended row is history that predates the domain: adopting it
        // makes `countDomainDependents` report sessions the domain never ran, which both
        // inflates the refusal message until an operator reaches for `--cascade`
        // reflexively AND makes that cascade delete 30 days of history that was never in
        // this domain. `deleteDomain` re-homes live rows rather than deleting them, so
        // scoping adoption the same way keeps the two halves consistent (#3039 review D).
        "SELECT session_id, cwd, repo_root FROM agent_sessions WHERE domain_id = ? AND ended_at IS NULL",
      )
      .all(NO_DOMAIN_ID);

    // One transaction, not N autocommits. This runs on every daemon start, and on a
    // post-sprint `agent_sessions` that would otherwise be thousands of individually
    // committed WAL writes blocking boot (#3039 review G).
    return this.db.transaction(() => {
      let adopted = 0;
      for (const row of rows) {
        const domainId = resolveStoredPathDomain([row.cwd, row.repo_root], domains);
        if (domainId === NO_DOMAIN_ID) continue;
        this.db.run("UPDATE agent_sessions SET domain_id = ? WHERE session_id = ?", [domainId, row.session_id]);
        adopted++;
      }
      return adopted;
    })();
  }

  listDomains(): Domain[] {
    return this.db
      .query<RawDomainRow, []>("SELECT id, name, host, path, created_at FROM domains ORDER BY name")
      .all()
      .map(toDomain);
  }

  getDomainByName(name: string): Domain | null {
    const row = this.db
      .query<RawDomainRow, [string]>("SELECT id, name, host, path, created_at FROM domains WHERE name = ?")
      .get(name);
    return row ? toDomain(row) : null;
  }

  getDomainById(id: number): Domain | null {
    const row = this.db
      .query<RawDomainRow, [number]>("SELECT id, name, host, path, created_at FROM domains WHERE id = ?")
      .get(id);
    return row ? toDomain(row) : null;
  }

  /**
   * Rename a domain. Returns the renamed row, or `null` when no domain is called
   * `oldName`; throws a {@link DomainConflictError} when `newName` is already taken.
   *
   * One transaction, and the renamed row comes back by `RETURNING` rather than a re-read
   * (#3210). The caller used to check "does `newName` exist?" and then UPDATE, which under
   * two writers surfaced a bare `SQLITE_CONSTRAINT_UNIQUE` on `domains.name` — see the
   * note on {@link createDomain} for why the transaction is `.immediate()`. The re-read
   * mattered too: it ran outside the write and reported "failed to rename" if anything
   * touched the row in between, which is a lie about what happened.
   *
   * A name change and nothing else **in the `domains` row**: `id` is untouched, so every
   * `domain_id` reference survives, and `path` is untouched, so `which` keeps resolving.
   * That is also why there is no canonicalization to redo here — rename takes no path.
   *
   * Mail is the one place a domain's **name** is stored outside this table, so it moves
   * with the rename (#3247). A cross-domain message's `sender` is stamped `local@name` at
   * send time — a human-readable return address is the point (`docs/domains.md`) — and a
   * rename that rewrote only `domains.name` left every one of those stamps pointing at a
   * name no longer in the table: the reply re-parsed `local@old`, missed, and threw
   * `unknown domain`. {@link restampMailSenders} rewrites them in **this** transaction, so
   * the two either both land or neither does. A rename that committed while the restamp
   * failed would leave mail attributed to a domain that no longer exists, which is exactly
   * the state this fixes.
   *
   * This is a **data** migration, not a schema one: no column, index or table changes, so
   * it is not a `migrate()` step and carries no version bump.
   */
  renameDomain(oldName: string, newName: string): Domain | null {
    if (!isValidDomainName(newName)) {
      throw new Error(`invalid domain name "${newName}": must be alphanumeric, hyphens, or underscores`);
    }
    return this.db
      .transaction(() => {
        const existing = this.getDomainByName(oldName);
        if (!existing) return null;
        // Guarded on `oldName !== newName` so renaming a domain to its own name stays the
        // no-op it has always been rather than colliding with itself.
        if (oldName !== newName) {
          const taken = this.getDomainByName(newName);
          if (taken) throw new DomainConflictError("name", newName, taken);
        }
        const row = this.db
          .query<RawDomainRow, [string, number]>(
            `UPDATE domains SET name = ? WHERE id = ?
             RETURNING id, name, host, path, created_at`,
          )
          .get(newName, existing.id);
        if (!row) throw new Error(`failed to rename domain "${oldName}" to "${newName}"`);
        // Same transaction as the row above, deliberately — see the docstring. Guarded on
        // the no-op rename only to skip pointless work; the UPDATE is a no-op there anyway.
        if (oldName !== newName) this.restampMailSenders(oldName, newName);
        return toDomain(row);
      })
      .immediate();
  }

  /**
   * Rewrite every mail `sender` stamped `local@oldName` to `local@newName`.
   *
   * Returns the number of rows rewritten. Private: a stamped sender is only ever migrated
   * as part of a rename, and a public entry point would be a way to rewrite return
   * addresses to a name no domain holds.
   *
   * **Not** scoped to a partition, and not scoped to the renamed domain's own rows: a
   * stamp for domain `alpha` lives in the *recipient's* partition by construction
   * (`resolveDelivery` writes the row into the recipient's domain), so scoping this to
   * `alpha` would rewrite exactly the rows that do not exist and miss every row that does.
   *
   * The suffix test is `substr`, **not** `LIKE '%@' || ?`. A domain name may contain `_`
   * (`isValidDomainName`), and `_` is a single-character wildcard in LIKE — so renaming
   * `alpha_b` would also restamp senders from a domain called `alphaXb`, silently
   * redirecting a third party's replies. The `length(sender) > length(?1) + 1` guard keeps
   * a pathological `"@alpha"` (empty local part, unreachable via `parseMailAddress` but
   * possible in a row written before #3038) from being rewritten into another `"@name"`.
   */
  private restampMailSenders(oldName: string, newName: string): number {
    return this.db.run(
      `UPDATE mail SET sender = substr(sender, 1, length(sender) - length(?1) - 1) || '@' || ?2
        WHERE ${SENDER_STAMPED_WITH}`,
      [oldName, newName],
    ).changes;
  }

  /**
   * How many mail rows **outside** `exceptDomainId` carry a return address stamped with
   * `name` (#3247)?
   *
   * The other half of the rename fix, for the operation a rename cannot help: `rm`. These
   * rows are not `countDomainDependents` dependents — they carry another domain's
   * `domain_id` — so nothing counted them, and removing a domain that had sent
   * cross-domain mail silently stranded every reply to it.
   *
   * `exceptDomainId` excludes the domain's own partition: those rows ARE dependents,
   * they are already counted and already cascaded, and counting them twice would refuse
   * over rows the cascade handles.
   */
  countStampedSenders(name: string, exceptDomainId: number): number {
    const row = this.db
      .query<{ n: number }, [string, number]>(
        `SELECT count(*) AS n FROM mail WHERE domain_id <> ?2 AND ${SENDER_STAMPED_WITH}`,
      )
      .get(name, exceptDomainId);
    return row?.n ?? 0;
  }

  /**
   * Every table in this database that carries a `domain_id`, derived from the schema.
   *
   * Deliberately NOT a hand-maintained constant. The same list previously existed in
   * four places with nothing tying them together, so a later PR that adds a partitioned
   * table and updates none of them got green tests and a `deleteDomain` that silently
   * under-counted. A list a future PR can forget to update is prose; a derivation it
   * cannot forget is a function — which is the principle this whole epic is built on.
   */
  listPartitionedTables(): string[] {
    return listPartitionedTables(this.db);
  }

  /** Per-table counts of rows currently bound to `domainId`. Only non-zero entries. */
  countDomainDependents(domainId: number): Array<{ table: string; rows: number }> {
    const out: Array<{ table: string; rows: number }> = [];
    for (const table of this.listPartitionedTables()) {
      const row = this.db
        .query<{ n: number }, [number]>(`SELECT count(*) AS n FROM ${quoteSqlIdent(table)} WHERE domain_id = ?`)
        .get(domainId);
      if ((row?.n ?? 0) > 0) out.push({ table, rows: row?.n ?? 0 });
    }
    return out;
  }

  /**
   * Delete a domain row. **Refuses by default** while anything still references it;
   * `{ cascade: true }` deletes the dependents with it.
   *
   * Refusing is the default deliberately: a domain is a name bound to a location — pure
   * routing data (`docs/domains.md`). Un-registering a route is not a statement that the
   * project's work items, mail and PR watermarks should be destroyed, and a silent
   * cascade makes an unrecoverable deletion the response to a typo. The error names the
   * per-table counts so the caller can decide. `mcx domain rm` (#3035) surfaces this as
   * a refusal plus an explicit `--cascade`.
   *
   * `AUTOINCREMENT` on `domains.id` is the other half: even if a row is orphaned some
   * other way, that id is never handed to a future domain, so nothing gets adopted.
   *
   * The refusal is a {@link DomainHasDependentsError} carrying the counts it was decided
   * on — every other throw is a real failure. That distinction is the caller's only
   * honest way to tell "refused" from "broke"; see the catch in `handlers/domain.ts`.
   *
   * ## Stamped return addresses are a second refusal reason, and cascade does NOT clear them
   *
   * A cross-domain message stamps `local@this-domain` into the **recipient's** partition
   * (#3247), so those rows carry someone else's `domain_id` and `countDomainDependents`
   * has never seen them. Deleting a domain that had sent cross-domain mail therefore
   * succeeded silently and left every reply to it throwing `unknown domain`.
   * {@link countStampedSenders} makes that a refusal too — the operator hears about it
   * before it is unrecoverable, which is the same argument the dependents refusal is built
   * on.
   *
   * Under `cascade` those rows are deliberately left **exactly as they are**:
   *
   * - Deleting them is not an option. They are another domain's inbox. `mcx domain rm
   *   alpha --force` destroying `beta`'s messages is the partition violation this whole
   *   epic exists to prevent, and the operator naming `alpha` has said nothing about
   *   `beta`.
   * - Stripping the `@alpha` qualifier is worse than leaving it: a bare sender re-parses
   *   as a mailbox in the *reader's own* domain, so the reply would silently deliver
   *   somewhere nobody addressed. `mail-domain.ts` refuses to degrade a failed resolution
   *   into a delivery for exactly this reason.
   * - A `local@<deleted:alpha>` tombstone buys nothing and costs the recovery. The current
   *   throw already names the domain and already says `register it with mcx domain add`,
   *   so provenance is not missing — and re-registering the name is what makes those
   *   replies work again. A tombstone would make the strand permanent to buy an error
   *   message that says less.
   *
   * So the loud, reversible failure is kept, and the refusal is what turns it into a
   * choice.
   */
  deleteDomain(name: string, opts?: { cascade?: boolean }): boolean {
    const domain = this.getDomainByName(name);
    if (!domain) return false;

    // Counted INSIDE the transaction: counting first and deleting after let a row
    // inserted into a table that counted zero survive the cascade as an orphan.
    //
    // `.immediate()`, not the default DEFERRED: this body reads (countDomainDependents)
    // and then writes, and DEFERRED takes the write lock only at that first write. Under
    // WAL a writer that commits in between invalidates our read snapshot and the upgrade
    // fails with SQLITE_BUSY_SNAPSHOT — which `busy_timeout` does NOT retry, because it
    // only covers lock contention on acquiring a lock, not a snapshot conflict on
    // upgrading one. IMMEDIATE takes the write lock at BEGIN, so the contending writer is
    // the one that waits out `busy_timeout` and we never see a stale snapshot.
    // `WorkItemDb.updateWorkItem` is immediate for exactly this reason (#3180).
    return this.db
      .transaction(() => {
        const dependents = this.countDomainDependents(domain.id);
        // Counted inside the transaction for the same reason as `dependents`: a stamp
        // written by a send that commits between a count and the delete would otherwise be
        // stranded by a delete that reported nothing to strand.
        const stranded = this.countStampedSenders(domain.name, domain.id);
        if ((dependents.length > 0 || stranded > 0) && !opts?.cascade) {
          throw new DomainHasDependentsError(name, dependents, stranded);
        }
        // A LIVE session row is not project data — it is the daemon's only handle on a
        // running child process. `orphan-reaper` finds children by iterating
        // `listSessions(true)`, and `bye` needs the row too, so deleting it leaves a
        // claude/codex process unreapable, un-endable, and invisible to restart cleanup.
        // Re-home those to the unassigned sentinel instead; the domain still goes away,
        // and the handle survives. Ended rows ARE history and cascade normally.
        //
        // This PR is what arms the hazard: before `domain_id` had a writer every session
        // row was 0 and this cascade never matched one (#3039 review 7).
        const rehomed = this.db.run(
          "UPDATE agent_sessions SET domain_id = ? WHERE domain_id = ? AND ended_at IS NULL",
          [NO_DOMAIN_ID, domain.id],
        ).changes;

        for (const { table } of dependents) {
          this.db.run(`DELETE FROM ${quoteSqlIdent(table)} WHERE domain_id = ?`, [domain.id]);
        }
        void rehomed; // reported by `mcx domain rm` (#3035); McxDb has no logger by design
        return this.db.run("DELETE FROM domains WHERE id = ?", [domain.id]).changes > 0;
      })
      .immediate();
  }

  /**
   * Which domain owns `path`? Longest registered prefix wins; `null` outside every
   * domain. Callers turn `null` into an error, never a guess — see
   * {@link resolveDomainForPath}, which holds the rule so it can be unit-tested
   * without a database.
   *
   * Canonicalizes `path` first so a symlinked cwd (every `.claude/worktrees/` path)
   * matches the canonical form stored by {@link createDomain}.
   */
  resolveDomain(path: string): Domain | null {
    return resolveDomainForPath(canonicalizeDomainPath(path), this.listDomains());
  }

  close(): void {
    this.db.close();
  }
}

// -- Helpers --

/**
 * Quote a SQL identifier. These come from `sqlite_master`, never from user input, but
 * interpolation into SQL is quoted unconditionally rather than trusted case by case.
 */
function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * First of `paths` that resolves to a registered domain, or `NO_DOMAIN_ID`.
 *
 * Stored paths are not trusted to be absolute or to still exist: `canonicalizeDomainPath`
 * throws on a relative one, and a row written before that rule existed can hold anything.
 * A path that cannot be resolved is skipped rather than aborting the whole backfill —
 * one malformed historical row must not stop the rest of a user's sessions being adopted.
 */
function resolveStoredPathDomain(paths: Array<string | null>, domains: Domain[]): number {
  for (const path of paths) {
    if (!path) continue;
    try {
      const domain = resolveDomainForPath(canonicalizeDomainPath(path), domains);
      if (domain) return domain.id;
    } catch {
      // not an absolute path — cannot name a domain; try the next candidate
    }
  }
  return NO_DOMAIN_ID;
}

/** Format a JS timestamp as a SQLite-compatible datetime string (`YYYY-MM-DD HH:MM:SS`). */
function formatSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** Max bytes allowed for a single alias_state value (256 KB). */
const ALIAS_STATE_MAX_VALUE_BYTES = 256 * 1024;

/**
 * Parse a value_json column without poisoning the handler on corrupt rows —
 * return undefined and log the offending scope so the caller can clean up
 * manually without every future get/all call for that scope erroring out.
 */
function safeParseStateValue(json: string, scopeForLog: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn(`[alias-state] corrupt value_json at ${scopeForLog}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

/** Escape SQL LIKE wildcards (% and _) with backslash. Use with ESCAPE '\\'. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Parse JSON safely, returning fallback on corrupt/invalid data. */
function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

interface RawDomainRow {
  id: number;
  name: string;
  host: string | null;
  path: string;
  created_at: string;
}

function toDomain(row: RawDomainRow): Domain {
  return { id: row.id, name: row.name, host: row.host, path: row.path, createdAt: row.created_at };
}

interface RawSessionRow {
  session_id: string;
  name: string | null;
  provider: string;
  pid: number | null;
  pid_start_time: number | null;
  state: string;
  model: string | null;
  cwd: string | null;
  worktree: string | null;
  repo_root: string | null;
  total_cost: number;
  total_tokens: number;
  spawned_at: string;
  ended_at: string | null;
  claude_session_id: string | null;
  transport: string | null;
  domain_id: number;
}

function toSessionRow(row: RawSessionRow): AgentSessionRow {
  return {
    sessionId: row.session_id,
    name: row.name,
    provider: row.provider,
    pid: row.pid,
    pidStartTime: row.pid_start_time,
    state: row.state,
    model: row.model,
    cwd: row.cwd,
    worktree: row.worktree,
    repoRoot: row.repo_root,
    totalCost: row.total_cost,
    totalTokens: row.total_tokens,
    spawnedAt: row.spawned_at,
    endedAt: row.ended_at,
    claudeSessionId: row.claude_session_id,
    transport: row.transport,
    domainId: row.domain_id,
  };
}

interface RawMailRow {
  id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string | null;
  reply_to: number | null;
  read: number;
  domain_id: number;
  created_at: string;
}

/**
 * The projection every mail read shares. Single-sourced so a column added to one query
 * and forgotten in another cannot make two reads of the same row disagree — `domain_id`
 * in particular has to come back from all of them, since it is what callers stamp onto
 * events.
 */
const MAIL_SELECT =
  "SELECT id, sender, recipient, subject, body, reply_to, read, domain_id, created_at FROM mail" as const;

function toMailMessage(row: RawMailRow): MailMessage {
  return {
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    replyTo: row.reply_to,
    read: row.read === 1,
    domainId: row.domain_id,
    createdAt: row.created_at,
  };
}
