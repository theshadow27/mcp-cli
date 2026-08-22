/**
 * @rule domain-scoped-queries
 * @expect 3
 * @path packages/daemon/src/db/things.ts
 *
 * The `@domain-partitioned` marker below is what opts this module into the rule.
 *
 * Three unscoped statements against a table the file itself declares with a `domain_id`
 * column: a lookup by a per-domain unique key, an INSERT that omits the column, and a
 * DELETE. Each returns or writes something plausible and wrong.
 */

// @domain-partitioned

import type { Database } from "bun:sqlite";

declare const db: Database;

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS things (
      id        TEXT PRIMARY KEY,
      domain_id INTEGER NOT NULL DEFAULT 0,
      pr_number INTEGER
    );
  `);
}

export function getByPr(prNumber: number): unknown {
  return db.query("SELECT * FROM things WHERE pr_number = ?").get(prNumber);
}

export function insert(id: string): void {
  db.query("INSERT INTO things (id, pr_number) VALUES (?, ?)").run(id, null);
}

export function removeAll(): void {
  db.query("DELETE FROM things").run();
}
