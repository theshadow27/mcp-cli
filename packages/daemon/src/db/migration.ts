import type { Database } from "bun:sqlite";

/**
 * Add a column to a table if it doesn't already exist.
 *
 * Checks PRAGMA table_info before executing ddl — idempotent by construction,
 * so no catch is needed and transient errors (SQLITE_BUSY, disk-full,
 * corruption) propagate to the caller.
 */
export function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  if (!cols.includes(column)) {
    db.exec(ddl);
  }
}
