/**
 * SQLite persistence layer for daemon state.
 *
 * Uses bun:sqlite for zero-dependency persistence of:
 * - Tool cache (survive daemon restarts)
 * - Usage statistics
 * - Daemon state (config hash, etc.)
 */

import { Database } from "bun:sqlite";
import { type AliasType, type MailMessage, type ToolInfo, type UsageStat, hardenFile, options } from "@mcp-cli/core";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export type { UsageStat } from "@mcp-cli/core";

export interface ClaudeSessionRow {
  sessionId: string;
  pid: number | null;
  state: string;
  model: string | null;
  cwd: string | null;
  worktree: string | null;
  totalCost: number;
  totalTokens: number;
  spawnedAt: string;
  endedAt: string | null;
}

export class StateDb {
  private db: Database;
  private logInsertCount = new Map<string, number>();
  private mailOpCount = 0;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    hardenFile(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.migrate();
  }

  // -- Migrations --

  private migrate(): void {
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
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_usage_server_tool ON usage_stats(server_name, tool_name);

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

      CREATE TABLE IF NOT EXISTS claude_sessions (
        session_id   TEXT PRIMARY KEY,
        pid          INTEGER,
        state        TEXT NOT NULL DEFAULT 'connecting',
        model        TEXT,
        cwd          TEXT,
        worktree     TEXT,
        total_cost   REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        spawned_at   TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at     TEXT
      );
    `);

    // -- Additive migrations (new columns on existing tables) --
    try {
      this.db.exec("ALTER TABLE aliases ADD COLUMN alias_type TEXT NOT NULL DEFAULT 'freeform'");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE aliases ADD COLUMN input_schema_json TEXT");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE aliases ADD COLUMN output_schema_json TEXT");
    } catch {
      /* column already exists */
    }
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

  recordUsage(server: string, tool: string, durationMs: number, success: boolean, error?: string): void {
    this.db.run(
      "INSERT INTO usage_stats (server_name, tool_name, duration_ms, success, error_message) VALUES (?, ?, ?, ?, ?)",
      [server, tool, durationMs, success ? 1 : 0, error ?? null],
    );
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
  }> {
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
        },
        []
      >(
        "SELECT name, description, file_path, updated_at, alias_type, input_schema_json, output_schema_json FROM aliases ORDER BY name",
      )
      .all()
      .map((row) => ({
        name: row.name,
        description: row.description ?? "",
        filePath: row.file_path,
        updatedAt: row.updated_at,
        aliasType: row.alias_type as AliasType,
        ...(row.input_schema_json ? { inputSchemaJson: safeJsonParse(row.input_schema_json, {}) } : {}),
        ...(row.output_schema_json ? { outputSchemaJson: safeJsonParse(row.output_schema_json, {}) } : {}),
      }));
  }

  getAlias(name: string): { name: string; description: string; filePath: string; aliasType: AliasType } | undefined {
    const row = this.db
      .query<{ name: string; description: string | null; file_path: string; alias_type: string }, [string]>(
        "SELECT name, description, file_path, alias_type FROM aliases WHERE name = ?",
      )
      .get(name);
    if (!row) return undefined;
    return {
      name: row.name,
      description: row.description ?? "",
      filePath: row.file_path,
      aliasType: row.alias_type as AliasType,
    };
  }

  saveAlias(
    name: string,
    filePath: string,
    description?: string,
    aliasType: AliasType = "freeform",
    inputSchemaJson?: string,
    outputSchemaJson?: string,
  ): void {
    this.db.run(
      `INSERT INTO aliases (name, file_path, description, alias_type, input_schema_json, output_schema_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(name) DO UPDATE SET
         file_path = excluded.file_path,
         description = excluded.description,
         alias_type = excluded.alias_type,
         input_schema_json = excluded.input_schema_json,
         output_schema_json = excluded.output_schema_json,
         updated_at = unixepoch()`,
      [name, filePath, description ?? null, aliasType, inputSchemaJson ?? null, outputSchemaJson ?? null],
    );
  }

  deleteAlias(name: string): void {
    this.db.run("DELETE FROM aliases WHERE name = ?", [name]);
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
      .all(...params)[0];
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

  // -- Claude sessions --

  upsertSession(session: {
    sessionId: string;
    pid?: number;
    state?: string;
    model?: string;
    cwd?: string;
    worktree?: string;
  }): void {
    this.db.run(
      `INSERT INTO claude_sessions (session_id, pid, state, model, cwd, worktree)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         pid = COALESCE(excluded.pid, claude_sessions.pid),
         state = COALESCE(excluded.state, claude_sessions.state),
         model = COALESCE(excluded.model, claude_sessions.model),
         cwd = COALESCE(excluded.cwd, claude_sessions.cwd),
         worktree = COALESCE(excluded.worktree, claude_sessions.worktree)`,
      [
        session.sessionId,
        session.pid ?? null,
        session.state ?? "connecting",
        session.model ?? null,
        session.cwd ?? null,
        session.worktree ?? null,
      ],
    );
  }

  updateSessionState(sessionId: string, state: string): void {
    this.db.run("UPDATE claude_sessions SET state = ? WHERE session_id = ?", [state, sessionId]);
  }

  updateSessionCost(sessionId: string, cost: number, tokens: number): void {
    this.db.run("UPDATE claude_sessions SET total_cost = ?, total_tokens = ? WHERE session_id = ?", [
      cost,
      tokens,
      sessionId,
    ]);
  }

  endSession(sessionId: string): void {
    this.db.run("UPDATE claude_sessions SET state = 'ended', ended_at = datetime('now') WHERE session_id = ?", [
      sessionId,
    ]);
  }

  getSession(sessionId: string): ClaudeSessionRow | null {
    const row = this.db
      .query<RawSessionRow, [string]>(
        "SELECT session_id, pid, state, model, cwd, worktree, total_cost, total_tokens, spawned_at, ended_at FROM claude_sessions WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? toSessionRow(row) : null;
  }

  listSessions(active?: boolean): ClaudeSessionRow[] {
    const where = active === true ? " WHERE ended_at IS NULL" : active === false ? " WHERE ended_at IS NOT NULL" : "";
    return this.db
      .query<RawSessionRow, []>(
        `SELECT session_id, pid, state, model, cwd, worktree, total_cost, total_tokens, spawned_at, ended_at FROM claude_sessions${where} ORDER BY spawned_at DESC`,
      )
      .all()
      .map(toSessionRow);
  }

  pruneOldSessions(maxAgeDays = 30): number {
    const cutoff = formatSqliteDatetime(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const result = this.db.run("DELETE FROM claude_sessions WHERE ended_at IS NOT NULL AND ended_at < ?", [cutoff]);
    return result.changes;
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
  pid: number | null;
  state: string;
  model: string | null;
  cwd: string | null;
  worktree: string | null;
  total_cost: number;
  total_tokens: number;
  spawned_at: string;
  ended_at: string | null;
}

function toSessionRow(row: RawSessionRow): ClaudeSessionRow {
  return {
    sessionId: row.session_id,
    pid: row.pid,
    state: row.state,
    model: row.model,
    cwd: row.cwd,
    worktree: row.worktree,
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
