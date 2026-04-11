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
  PRIMARY KEY (provider, cloud_id, id)
);

CREATE INDEX IF NOT EXISTS idx_entries_path ON entries(local_path);
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

export class CloneCache {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }

  /** Upsert an entry after fetch. */
  upsert(
    provider: string,
    scope: ResolvedScope,
    entry: RemoteEntry,
    localPath: string,
    contentHash: string | null,
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO entries
				(id, provider, scope_key, cloud_id, title, parent_id, local_path, version, last_modified, fetched_at, content_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  /** Get a cached entry by local path. */
  getByPath(localPath: string): CachedEntry | null {
    const row = this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash
				FROM entries WHERE local_path = ?`,
      )
      .get(localPath) as CachedEntry | null;
    return row;
  }

  /** Get a cached entry by remote ID. */
  getById(provider: string, cloudId: string, id: string): CachedEntry | null {
    const row = this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash
				FROM entries WHERE provider = ? AND cloud_id = ? AND id = ?`,
      )
      .get(provider, cloudId, id) as CachedEntry | null;
    return row;
  }

  /** Get all entries for a scope. */
  listScope(provider: string, scopeKey: string): CachedEntry[] {
    return this.db
      .query(
        `SELECT id, provider, scope_key as scopeKey, cloud_id as cloudId, title,
				parent_id as parentId, local_path as localPath, version,
				last_modified as lastModified, fetched_at as fetchedAt, content_hash as contentHash
				FROM entries WHERE provider = ? AND scope_key = ?`,
      )
      .all(provider, scopeKey) as CachedEntry[];
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

  /** Remove an entry. */
  remove(provider: string, cloudId: string, id: string): void {
    this.db.query("DELETE FROM entries WHERE provider = ? AND cloud_id = ? AND id = ?").run(provider, cloudId, id);
  }

  close(): void {
    this.db.close();
  }
}
