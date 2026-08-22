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

export class StateDb {
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
        reply_to INTEGER REFERENCES mail(id),
        read INTEGER NOT NULL DEFAULT 0,
        domain_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_mail_recipient
        ON mail(recipient, read, created_at);

      -- No domain index on mail yet, for the same reason event-log.ts declines one on
      -- monitor_events: insertMail has no domainId parameter until #3038, so every row
      -- is 0 and the index is write amplification for something nothing can use.

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

  // -- Mail --

  insertMail(sender: string, recipient: string, subject?: string, body?: string, replyTo?: number): number {
    const result = this.db.run("INSERT INTO mail (sender, recipient, subject, body, reply_to) VALUES (?, ?, ?, ?, ?)", [
      sender,
      recipient,
      subject ?? null,
      body ?? null,
      replyTo ?? null,
    ]);
    this.maybeRunMailPrune();
    return Number(result.lastInsertRowid);
  }

  readMail(recipient?: string, unreadOnly?: boolean, limit?: number): MailMessage[] {
    this.maybeRunMailPrune();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (recipient) {
      conditions.push("(recipient = ? OR recipient = '*')");
      params.push(recipient);
    }
    if (unreadOnly) {
      conditions.push("read = 0");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = limit ? " LIMIT ?" : "";
    if (limit) params.push(limit);

    return this.db
      .query<
        {
          id: number;
          sender: string;
          recipient: string;
          subject: string | null;
          body: string | null;
          reply_to: number | null;
          read: number;
          created_at: string;
        },
        (string | number)[]
      >(
        `SELECT id, sender, recipient, subject, body, reply_to, read, created_at FROM mail ${where} ORDER BY created_at DESC${limitClause}`,
      )
      .all(...params)
      .map(toMailMessage);
  }

  getMailById(id: number): MailMessage | undefined {
    const row = this.db
      .query<
        {
          id: number;
          sender: string;
          recipient: string;
          subject: string | null;
          body: string | null;
          reply_to: number | null;
          read: number;
          created_at: string;
        },
        [number]
      >("SELECT id, sender, recipient, subject, body, reply_to, read, created_at FROM mail WHERE id = ?")
      .get(id);
    return row ? toMailMessage(row) : undefined;
  }

  getNextUnread(recipient?: string): MailMessage | undefined {
    const conditions = ["read = 0"];
    const params: (string | number)[] = [];

    if (recipient) {
      conditions.push("(recipient = ? OR recipient = '*')");
      params.push(recipient);
    }

    const where = conditions.join(" AND ");
    const row = this.db
      .query<
        {
          id: number;
          sender: string;
          recipient: string;
          subject: string | null;
          body: string | null;
          reply_to: number | null;
          read: number;
          created_at: string;
        },
        (string | number)[]
      >(
        `SELECT id, sender, recipient, subject, body, reply_to, read, created_at FROM mail WHERE ${where} ORDER BY created_at ASC LIMIT 1`,
      )
      .get(...params);
    return row ? toMailMessage(row) : undefined;
  }

  markMailRead(id: number): void {
    this.db.run("UPDATE mail SET read = 1 WHERE id = ?", [id]);
  }

  /** Delete read messages older than ttlMs. Called opportunistically. */
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

  getAliasState(repoRoot: string, namespace: string, key: string, domainId: number = NO_DOMAIN_ID): unknown {
    const row = this.db
      .query<{ value_json: string }, [number, string, string, string]>(
        "SELECT value_json FROM alias_state WHERE domain_id = ? AND repo_root = ? AND namespace = ? AND key = ?",
      )
      .get(domainId, repoRoot, namespace, key);
    if (!row) return undefined;
    return safeParseStateValue(row.value_json, `${repoRoot}/${namespace}/${key}`);
  }

  setAliasState(
    repoRoot: string,
    namespace: string,
    key: string,
    value: unknown,
    domainId: number = NO_DOMAIN_ID,
  ): void {
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

  deleteAliasState(repoRoot: string, namespace: string, key: string, domainId: number = NO_DOMAIN_ID): boolean {
    const result = this.db.run(
      "DELETE FROM alias_state WHERE domain_id = ? AND repo_root = ? AND namespace = ? AND key = ?",
      [domainId, repoRoot, namespace, key],
    );
    return result.changes > 0;
  }

  listAliasState(repoRoot: string, namespace: string, domainId: number = NO_DOMAIN_ID): Record<string, unknown> {
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
   * Register a domain. Throws on a duplicate name or a duplicate `[host:]path` location.
   *
   * A **local** path is canonicalized (absolute, symlinks resolved) so the resolver
   * compares like with like — #1526 and #1684 were both this bug in other tables.
   * A **host-bound** path is stored verbatim: it names a directory on another machine,
   * so normalizing it against this filesystem is meaningless and `~/work` there is that
   * host's home, not ours.
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
    const row = this.db
      .query<RawDomainRow, [string, string | null, string]>(
        `INSERT INTO domains (name, host, path, created_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         RETURNING id, name, host, path, created_at`,
      )
      .get(name, host, storedPath);
    if (!row) throw new Error(`failed to create domain "${name}"`);
    const domain = toDomain(row);
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
   * ran `mcx scope`. Worse than the empty list: `mcx claude bye --all --scoped` also
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

  renameDomain(oldName: string, newName: string): boolean {
    if (!isValidDomainName(newName)) {
      throw new Error(`invalid domain name "${newName}": must be alphanumeric, hyphens, or underscores`);
    }
    return this.db.run("UPDATE domains SET name = ? WHERE name = ?", [newName, oldName]).changes > 0;
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
   */
  deleteDomain(name: string, opts?: { cascade?: boolean }): boolean {
    const domain = this.getDomainByName(name);
    if (!domain) return false;

    // Counted INSIDE the transaction: counting first and deleting after let a row
    // inserted into a table that counted zero survive the cascade as an orphan.
    return this.db.transaction(() => {
      const dependents = this.countDomainDependents(domain.id);
      if (dependents.length > 0 && !opts?.cascade) {
        const detail = dependents.map((d) => `${d.table}=${d.rows}`).join(", ");
        const total = dependents.reduce((n, d) => n + d.rows, 0);
        throw new Error(
          `domain "${name}" still has ${total} dependent row(s) (${detail}); reassign or delete them first, or pass cascade to remove them with the domain`,
        );
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
      const rehomed = this.db.run("UPDATE agent_sessions SET domain_id = ? WHERE domain_id = ? AND ended_at IS NULL", [
        NO_DOMAIN_ID,
        domain.id,
      ]).changes;

      for (const { table } of dependents) {
        this.db.run(`DELETE FROM ${quoteSqlIdent(table)} WHERE domain_id = ?`, [domain.id]);
      }
      void rehomed; // reported by `mcx domain rm` (#3035); StateDb has no logger by design
      return this.db.run("DELETE FROM domains WHERE id = ?", [domain.id]).changes > 0;
    })();
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

function toMailMessage(row: {
  id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string | null;
  reply_to: number | null;
  read: number;
  created_at: string;
}): MailMessage {
  return {
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    replyTo: row.reply_to,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}
