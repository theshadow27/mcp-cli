import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { addColumnIfMissing } from "./migration";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  return db;
}

function columnNames(db: Database, table: string): string[] {
  // Mirror the production identifier check so tests don't introduce the unsafe pattern
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid table: ${table}`);
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe("addColumnIfMissing", () => {
  it("adds the column when absent", () => {
    const db = freshDb();
    addColumnIfMissing(db, "t", "extra", "ALTER TABLE t ADD COLUMN extra TEXT");
    expect(columnNames(db, "t")).toContain("extra");
  });

  it("is a no-op when column already exists", () => {
    const db = freshDb();
    addColumnIfMissing(db, "t", "name", "ALTER TABLE t ADD COLUMN name TEXT");
    expect(columnNames(db, "t").filter((c) => c === "name")).toHaveLength(1);
  });

  it("propagates errors from invalid DDL", () => {
    const db = freshDb();
    expect(() => addColumnIfMissing(db, "t", "bad", "THIS IS NOT VALID SQL")).toThrow();
  });

  it("can add multiple columns sequentially", () => {
    const db = freshDb();
    addColumnIfMissing(db, "t", "col_a", "ALTER TABLE t ADD COLUMN col_a TEXT");
    addColumnIfMissing(db, "t", "col_b", "ALTER TABLE t ADD COLUMN col_b INTEGER");
    const cols = columnNames(db, "t");
    expect(cols).toContain("col_a");
    expect(cols).toContain("col_b");
  });

  it("calling twice for the same column is a no-op (idempotent)", () => {
    const db = freshDb();
    addColumnIfMissing(db, "t", "extra", "ALTER TABLE t ADD COLUMN extra TEXT");
    addColumnIfMissing(db, "t", "extra", "ALTER TABLE t ADD COLUMN extra TEXT");
    expect(columnNames(db, "t").filter((c) => c === "extra")).toHaveLength(1);
  });

  it("rejects invalid table identifiers synchronously", () => {
    const db = freshDb();
    expect(() => addColumnIfMissing(db, "t; DROP TABLE t--", "col", "ALTER TABLE t ADD COLUMN col TEXT")).toThrow(
      /invalid table identifier/,
    );
    expect(() => addColumnIfMissing(db, "has space", "col", "ALTER TABLE t ADD COLUMN col TEXT")).toThrow(
      /invalid table identifier/,
    );
  });

  it("rejects invalid column identifiers synchronously", () => {
    const db = freshDb();
    expect(() => addColumnIfMissing(db, "t", "has space", "ALTER TABLE t ADD COLUMN col TEXT")).toThrow(
      /invalid column identifier/,
    );
    expect(() => addColumnIfMissing(db, "t", "col; DROP TABLE t--", "ALTER TABLE t ADD COLUMN col TEXT")).toThrow(
      /invalid column identifier/,
    );
  });

  it("rejects ddl that does not add the named column to the named table", () => {
    const db = freshDb();
    // wrong column name in ddl
    expect(() => addColumnIfMissing(db, "t", "col_a", "ALTER TABLE t ADD COLUMN col_b TEXT")).toThrow(
      /must add column/,
    );
    // wrong table name in ddl
    expect(() => addColumnIfMissing(db, "t", "col", "ALTER TABLE other ADD COLUMN col TEXT")).toThrow(
      /must add column/,
    );
  });

  it("is case-insensitive when checking whether a column already exists", () => {
    // SQLite identifiers are case-insensitive; PRAGMA returns stored case.
    // A column created as "Name" must be found when checked with "name".
    const db = new Database(":memory:");
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, "Name" TEXT)');
    addColumnIfMissing(db, "t", "name", "ALTER TABLE t ADD COLUMN name TEXT");
    // PRAGMA should still show exactly one column whose lowercased name is "name"
    const cols = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols.filter((c) => c.toLowerCase() === "name")).toHaveLength(1);
  });
});
