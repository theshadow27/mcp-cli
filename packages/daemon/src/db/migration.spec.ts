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
});
