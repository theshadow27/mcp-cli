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
  type MailMessage,
  type MonitorAliasMetadata,
  type Span,
  type SpanRow,
  type ToolInfo,
  type UsageStat,
  hardenFile,
  options,
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
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 3000");
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
   * Replaces the legacy bare `try { ALTER TABLE } catch {}` pattern that silently
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
        version = 3;
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
          ] as const) {
            if (!cols.has(col)) {
              this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} ${def}`);
            }
          }
        }
        version = 0;
      }
      this.db
        .query<void, [string, number]>("INSERT INTO schema_versions (name, version) VALUES (?, ?)")
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
  }

  private applyV1Schema(): void {
    this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS aliases (
        name TEXT PRIMARY KEY,
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
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_mail_recipient
        ON mail(recipient, read, created_at);

      CREATE TABLE IF NOT EXISTS notes (
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (server_name, tool_name)
      );

      CREATE TABLE IF NOT EXISTS alias_state (
        repo_root TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (repo_root, namespace, key)
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
        ended_at     TEXT
      );

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

      CREATE TABLE IF NOT EXISTS copilot_comment_state (
        pr_number              INTEGER PRIMARY KEY,
        seen_comment_ids       TEXT NOT NULL DEFAULT '[]',
        seen_review_ids        TEXT NOT NULL DEFAULT '[]',
        seen_pr_comment_ids    TEXT NOT NULL DEFAULT '[]',
        seen_issue_comment_ids TEXT NOT NULL DEFAULT '[]',
        last_sticky_body_hash  TEXT,
        last_poll_ts           TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private setSchemaVersion(name: string, version: number): void {
    this.db.query<void, [number, string]>("UPDATE schema_versions SET version = ? WHERE name = ?").run(version, name);
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

  listAliases(): Array<{
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
        [number]
      >(
        "SELECT name, description, file_path, updated_at, alias_type, input_schema_json, output_schema_json, expires_at, run_count, last_run_at, scope, monitor_definitions_json FROM aliases WHERE expires_at IS NULL OR expires_at > ? ORDER BY name",
      )
      .all(Date.now())
      .map((row) => ({
        name: row.name,
        description: row.description ?? "",
        filePath: row.file_path,
        updatedAt: row.updated_at,
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

  getAlias(name: string):
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
        [string]
      >(
        "SELECT name, description, file_path, alias_type, bundled_js, source_hash, expires_at, run_count, last_run_at, scope, monitor_definitions_json FROM aliases WHERE name = ?",
      )
      .get(name);
    if (!row) return undefined;
    return {
      name: row.name,
      description: row.description ?? "",
      filePath: row.file_path,
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
  ): void {
    // If the caller is saving an ephemeral alias (expiresAt set), refuse to
    // overwrite an existing permanent alias (expires_at IS NULL). This prevents
    // auto-save hash collisions from clobbering user-curated aliases.
    if (expiresAt != null) {
      const existing = this.db
        .query<{ expires_at: number | null }, [string]>("SELECT expires_at FROM aliases WHERE name = ?")
        .get(name);
      if (existing && existing.expires_at === null) {
        // Permanent alias exists — do not overwrite
        return;
      }
    }

    this.db.run(
      `INSERT INTO aliases (name, file_path, description, alias_type, input_schema_json, output_schema_json, bundled_js, source_hash, expires_at, scope, monitor_definitions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(name) DO UPDATE SET
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
      ],
    );
  }

  deleteAlias(name: string): void {
    this.db.run("DELETE FROM aliases WHERE name = ?", [name]);
  }

  /** Increment run_count and set last_run_at. Returns the new run count. */
  recordAliasRun(name: string): number {
    const row = this.db
      .query<{ run_count: number }, [string]>(
        "UPDATE aliases SET run_count = run_count + 1, last_run_at = unixepoch() WHERE name = ? RETURNING run_count",
      )
      .get(name);
    return row?.run_count ?? 0;
  }

  /** Reset the TTL on an ephemeral alias (called when re-run). */
  touchAliasExpiry(name: string, expiresAt: number): void {
    this.db.run(
      "UPDATE aliases SET expires_at = ?, updated_at = unixepoch() WHERE name = ? AND expires_at IS NOT NULL",
      [expiresAt, name],
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

    return this.db
      .query<{ line: string; timestamp_ms: number }, (string | number)[]>(
        `SELECT line, timestamp_ms FROM server_logs WHERE ${where} ORDER BY timestamp_ms ASC${limitClause}`,
      )
      .all(...params)
      .map((row) => ({ line: row.line, timestampMs: row.timestamp_ms }));
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
  }): void {
    this.db.run(
      `INSERT INTO agent_sessions (session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         name = COALESCE(excluded.name, agent_sessions.name),
         provider = COALESCE(excluded.provider, agent_sessions.provider),
         pid = COALESCE(excluded.pid, agent_sessions.pid),
         pid_start_time = COALESCE(excluded.pid_start_time, agent_sessions.pid_start_time),
         state = COALESCE(excluded.state, agent_sessions.state),
         model = COALESCE(excluded.model, agent_sessions.model),
         cwd = COALESCE(excluded.cwd, agent_sessions.cwd),
         worktree = COALESCE(excluded.worktree, agent_sessions.worktree),
         repo_root = COALESCE(excluded.repo_root, agent_sessions.repo_root)`,
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
        "SELECT session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root, total_cost, total_tokens, spawned_at, ended_at FROM agent_sessions WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? toSessionRow(row) : null;
  }

  listSessions(active?: boolean): AgentSessionRow[] {
    const where = active === true ? " WHERE ended_at IS NULL" : active === false ? " WHERE ended_at IS NOT NULL" : "";
    return this.db
      .query<RawSessionRow, []>(
        `SELECT session_id, name, provider, pid, pid_start_time, state, model, cwd, worktree, repo_root, total_cost, total_tokens, spawned_at, ended_at FROM agent_sessions${where} ORDER BY spawned_at DESC`,
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

  getAliasState(repoRoot: string, namespace: string, key: string): unknown {
    const row = this.db
      .query<{ value_json: string }, [string, string, string]>(
        "SELECT value_json FROM alias_state WHERE repo_root = ? AND namespace = ? AND key = ?",
      )
      .get(repoRoot, namespace, key);
    if (!row) return undefined;
    return safeParseStateValue(row.value_json, `${repoRoot}/${namespace}/${key}`);
  }

  setAliasState(repoRoot: string, namespace: string, key: string, value: unknown): void {
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
      `INSERT INTO alias_state (repo_root, namespace, key, value_json, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(repo_root, namespace, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [repoRoot, namespace, key, json],
    );
  }

  deleteAliasState(repoRoot: string, namespace: string, key: string): boolean {
    const result = this.db.run("DELETE FROM alias_state WHERE repo_root = ? AND namespace = ? AND key = ?", [
      repoRoot,
      namespace,
      key,
    ]);
    return result.changes > 0;
  }

  listAliasState(repoRoot: string, namespace: string): Record<string, unknown> {
    const rows = this.db
      .query<{ key: string; value_json: string }, [string, string]>(
        "SELECT key, value_json FROM alias_state WHERE repo_root = ? AND namespace = ?",
      )
      .all(repoRoot, namespace);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const parsed = safeParseStateValue(row.value_json, `${repoRoot}/${namespace}/${row.key}`);
      if (parsed !== undefined) out[row.key] = parsed;
    }
    return out;
  }

  // -- Copilot comment state (#1578) --

  getSeenCommentIds(prNumber: number): number[] {
    const row = this.db
      .query<{ seen_comment_ids: string }, [number]>(
        "SELECT seen_comment_ids FROM copilot_comment_state WHERE pr_number = ?",
      )
      .get(prNumber);
    return row ? safeJsonParse<number[]>(row.seen_comment_ids, []) : [];
  }

  updateSeenCommentIds(prNumber: number, ids: number[]): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, seen_comment_ids, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           seen_comment_ids = excluded.seen_comment_ids,
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(prNumber, JSON.stringify(ids));
  }

  // -- Review IDs (#1579) --

  getSeenReviewIds(prNumber: number): number[] {
    const row = this.db
      .query<{ seen_review_ids: string }, [number]>(
        "SELECT seen_review_ids FROM copilot_comment_state WHERE pr_number = ?",
      )
      .get(prNumber);
    return row ? safeJsonParse<number[]>(row.seen_review_ids, []) : [];
  }

  updateSeenReviewIds(prNumber: number, ids: number[]): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, seen_review_ids, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           seen_review_ids = excluded.seen_review_ids,
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(prNumber, JSON.stringify(ids));
  }

  // -- Top-level PR comment IDs (#1579) --

  getSeenPRCommentIds(prNumber: number): number[] {
    const row = this.db
      .query<{ seen_pr_comment_ids: string }, [number]>(
        "SELECT seen_pr_comment_ids FROM copilot_comment_state WHERE pr_number = ?",
      )
      .get(prNumber);
    return row ? safeJsonParse<number[]>(row.seen_pr_comment_ids, []) : [];
  }

  updateSeenPRCommentIds(prNumber: number, ids: number[]): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, seen_pr_comment_ids, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           seen_pr_comment_ids = excluded.seen_pr_comment_ids,
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(prNumber, JSON.stringify(ids));
  }

  // -- Issue comment IDs (#1579) --

  getSeenIssueCommentIds(issueNumber: number): number[] {
    const row = this.db
      .query<{ seen_issue_comment_ids: string }, [number]>(
        "SELECT seen_issue_comment_ids FROM copilot_comment_state WHERE pr_number = ?",
      )
      .get(issueNumber);
    return row ? safeJsonParse<number[]>(row.seen_issue_comment_ids, []) : [];
  }

  updateSeenIssueCommentIds(issueNumber: number, ids: number[]): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, seen_issue_comment_ids, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           seen_issue_comment_ids = excluded.seen_issue_comment_ids,
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(issueNumber, JSON.stringify(ids));
  }

  // -- Sticky body hash (#1579) --

  getStickyBodyHash(prNumber: number): string | null {
    const row = this.db
      .query<{ last_sticky_body_hash: string | null }, [number]>(
        "SELECT last_sticky_body_hash FROM copilot_comment_state WHERE pr_number = ?",
      )
      .get(prNumber);
    return row?.last_sticky_body_hash ?? null;
  }

  updateStickyBodyHash(prNumber: number, hash: string | null): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, last_sticky_body_hash, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           last_sticky_body_hash = excluded.last_sticky_body_hash,
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(prNumber, hash);
  }

  deleteCopilotCommentState(workItemNumber: number): boolean {
    if (workItemNumber === 0) return false;
    const result = this.db.run("DELETE FROM copilot_comment_state WHERE pr_number = ?", [workItemNumber]);
    return result.changes > 0;
  }

  getLastRepoPollTs(): string | null {
    const row = this.db
      .query<{ last_poll_ts: string }, []>("SELECT last_poll_ts FROM copilot_comment_state WHERE pr_number = 0")
      .get();
    return row?.last_poll_ts ?? null;
  }

  updateLastRepoPollTs(isoTs: string): void {
    this.db
      .query(
        `INSERT INTO copilot_comment_state (pr_number, last_poll_ts)
         VALUES (0, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           last_poll_ts = excluded.last_poll_ts`,
      )
      .run(isoTs);
  }

  close(): void {
    this.db.close();
  }
}

// -- Helpers --

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
