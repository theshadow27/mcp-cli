import type { Database } from "bun:sqlite";

// Restrict table identifiers to plain alphanumeric+underscore names so they
// can be safely interpolated into PRAGMA queries without quoting.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Add a column to a table if it doesn't already exist.
 *
 * Checks PRAGMA table_info before executing ddl. Safe for the single-writer
 * migration pattern used here — migrations run at daemon startup before
 * concurrent access begins. The check-then-act is NOT atomic: a concurrent
 * second writer that races past the PRAGMA check will hit a duplicate-column
 * error on exec(), which will propagate rather than be swallowed.
 *
 * `table` must be a plain identifier (alphanumeric + underscore). Throws
 * synchronously for anything else so misuse is caught at development time.
 */
export function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!IDENT_RE.test(table)) throw new Error(`addColumnIfMissing: invalid table identifier: ${table}`);
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  if (!cols.includes(column)) {
    db.exec(ddl);
  }
}
