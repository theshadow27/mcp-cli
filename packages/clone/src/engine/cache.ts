/**
 * SQLite cache for clone state.
 *
 * Tracks the mapping between remote entries (page IDs, versions) and local
 * filesystem paths. Used for path lookups, version conflict detection, and
 * incremental sync.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteEntry, ResolvedScope } from "../providers/provider";

export interface CachedEntry {
  id: string;
  provider: string;
  scopeKey: string;
  cloudId: string;
  title: string;
  parentId: string | null;
  localPath: string;
  version: number;
  lastModified: string;
  fetchedAt: string;
  contentHash: string | null;
  isStub: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope_key   TEXT NOT NULL,
  cloud_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  parent_id   TEXT,
  local_path  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  last_modified TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  content_hash TEXT,
  is_stub     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, cloud_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_local_path ON entries(provider, scope_key, local_path);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(provider, scope_key);

CREATE TABLE IF NOT EXISTS scope_meta (
  provider    TEXT NOT NULL,
  scope_key   TEXT NOT NULL,
  cloud_id    TEXT NOT NULL,
  resolved    TEXT NOT NULL,
  last_synced TEXT,
  PRIMARY KEY (provider, scope_key)
);
`;

/** Normalize SQLite INTEGER to boolean for isStub. */
function normalizeEntry(row: Record<string, unknown> | null): CachedEntry | null {
  if (!row) return null;
  return { ...row, isStub: !!(row.isStub as number) } as CachedEntry;
}

function normalizeEntries(rows: Record<string, unknown>[]): CachedEntry[] {
  return rows.map((r) => ({ ...r, isStub: !!(r.isStub as number) }) as CachedEntry);
}

export class CloneCache {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    // Migrate: add is_stub column for databases created before --depth support.
    // New databases already have it from CREATE TABLE; this only fires for pre-existing DBs.
    try {
      this.db.exec("ALTER TABLE entries ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("duplicate column")) throw err;
    }
  }

  /** Upsert an entry after fetch. */
  upsert(
    provider: string,
    scope: ResolvedScope,
    entry: RemoteEntry,
    localPath: string,
    contentHash: string | null,
    isStub = false,
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO entries
				(id, provider, scope_key, cloud_id, title, parent_id, local_path, version, last_modified, fetched_at, content_hash, is_stub)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        provider,
        scope.key,
        scope.cloudId,
        entry.title,
        entry.parentId ?? null,
        localPath,
        entry.version,
        entry.lastModified,
        new Date().toISOString(),
        contentHash,
        isStub ? 1 : 0,
      );
  }

  /** Get a cached entry by local path. */
  getByPath(localPath: string): CachedEntry | null {
    const row = this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash,
				is_stub as isStub
				FROM entries WHERE local_path = ?`,
      )
      .get(localPath) as Record<string, unknown> | null;
    return normalizeEntry(row);
  }

  /** Get a cached entry by remote ID. */
  getById(provider: string, cloudId: string, id: string): CachedEntry | null {
    const row = this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash,
				is_stub as isStub
				FROM entries WHERE provider = ? AND cloud_id = ? AND id = ?`,
      )
      .get(provider, cloudId, id) as Record<string, unknown> | null;
    return normalizeEntry(row);
  }

  /** Get all entries for a scope. */
  listScope(provider: string, scopeKey: string): CachedEntry[] {
    const rows = this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash,
				is_stub as isStub
				FROM entries WHERE provider = ? AND scope_key = ?`,
      )
      .all(provider, scopeKey) as Record<string, unknown>[];
    return normalizeEntries(rows);
  }

  /** Save resolved scope metadata. */
  saveScopeMeta(provider: string, scope: ResolvedScope): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO scope_meta (provider, scope_key, cloud_id, resolved, last_synced)
				VALUES (?, ?, ?, ?, ?)`,
      )
      .run(provider, scope.key, scope.cloudId, JSON.stringify(scope.resolved), new Date().toISOString());
  }

  /** Load resolved scope metadata. */
  loadScopeMeta(provider: string, scopeKey: string): ResolvedScope | null {
    const row = this.db
      .query(
        "SELECT scope_key as key, cloud_id as cloudId, resolved FROM scope_meta WHERE provider = ? AND scope_key = ?",
      )
      .get(provider, scopeKey) as { key: string; cloudId: string; resolved: string } | null;
    if (!row) return null;
    return { key: row.key, cloudId: row.cloudId, resolved: JSON.parse(row.resolved) };
  }

  /** Find the first scope for a provider (when we don't know the key). */
  findFirstScope(provider: string): ResolvedScope | null {
    const row = this.db
      .query("SELECT scope_key as key, cloud_id as cloudId, resolved FROM scope_meta WHERE provider = ? LIMIT 1")
      .get(provider) as { key: string; cloudId: string; resolved: string } | null;
    if (!row) return null;
    return { key: row.key, cloudId: row.cloudId, resolved: JSON.parse(row.resolved) };
  }

  /** Get the last sync timestamp for a scope. */
  getLastSynced(provider: string, scopeKey: string): string | null {
    const row = this.db
      .query("SELECT last_synced FROM scope_meta WHERE provider = ? AND scope_key = ?")
      .get(provider, scopeKey) as { last_synced: string | null } | null;
    return row?.last_synced ?? null;
  }

  /** Update the last sync timestamp for a scope. */
  updateLastSynced(provider: string, scopeKey: string): void {
    this.db
      .query("UPDATE scope_meta SET last_synced = ? WHERE provider = ? AND scope_key = ?")
      .run(new Date().toISOString(), provider, scopeKey);
  }

  /** Find the provider name from the first scope_meta row (when we don't know which provider was used). */
  findProviderName(): string | null {
    const row = this.db.query("SELECT provider FROM scope_meta ORDER BY rowid LIMIT 1").get() as {
      provider: string;
    } | null;
    return row?.provider ?? null;
  }

  /** Get the clone depth stored in scope_meta (0 = unlimited). */
  getCloneDepth(provider: string, scopeKey: string): number {
    const scope = this.loadScopeMeta(provider, scopeKey);
    const raw = scope?.resolved?.cloneDepth;
    const depth = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : 0;
    return Number.isFinite(depth) ? depth : 0;
  }

  /** Count stub entries for a scope. */
  countStubs(provider: string, scopeKey: string): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM entries WHERE provider = ? AND scope_key = ? AND is_stub = 1")
      .get(provider, scopeKey) as { count: number } | null;
    return row?.count ?? 0;
  }

  /** Remove an entry. */
  remove(provider: string, cloudId: string, id: string): void {
    this.db.query("DELETE FROM entries WHERE provider = ? AND cloud_id = ? AND id = ?").run(provider, cloudId, id);
  }

  close(): void {
    this.db.close();
  }
}
