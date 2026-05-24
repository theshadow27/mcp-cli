import type { Database } from "bun:sqlite";

// Restrict table/column identifiers to plain alphanumeric+underscore names so they
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
 * `table` and `column` must be plain identifiers (alphanumeric + underscore).
 * `ddl` must contain `ALTER TABLE <table> ADD COLUMN <column>` — validated
 * synchronously so a mismatched column/ddl pair is caught at development time,
 * not on a user's production database at daemon startup.
 *
 * Column presence is checked case-insensitively (SQLite identifiers are
 * case-insensitive; PRAGMA returns stored case).
 */
export function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!IDENT_RE.test(table)) throw new Error(`addColumnIfMissing: invalid table identifier: ${table}`);
  if (!IDENT_RE.test(column)) throw new Error(`addColumnIfMissing: invalid column identifier: ${column}`);
  const ddlPattern = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+${column}\\b`, "i");
  if (!ddlPattern.test(ddl)) {
    throw new Error(`addColumnIfMissing: ddl must add column "${column}" to table "${table}"`);
  }
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  if (!cols.some((c) => c.toLowerCase() === column.toLowerCase())) {
    db.exec(ddl);
  }
}
