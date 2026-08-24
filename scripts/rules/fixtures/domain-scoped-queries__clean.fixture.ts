/**
 * @rule domain-scoped-queries
 * @expect 0
 * @path packages/daemon/src/db/things.ts
 *
 * The `@domain-partitioned` marker below is what opts this module into the rule.
 *
 * The same statements, each constraining `domain_id`. Also covers the two shapes the rule
 * must NOT flag: the CREATE TABLE block itself, and a query against an unpartitioned table.
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
    CREATE TABLE IF NOT EXISTS schema_versions (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
}

export function getByPr(domainId: number, prNumber: number): unknown {
  return db.query("SELECT * FROM things WHERE domain_id = ? AND pr_number = ?").get(domainId, prNumber);
}

export function insert(domainId: number, id: string): void {
  db.query("INSERT INTO things (id, domain_id, pr_number) VALUES (?, ?, ?)").run(id, domainId, null);
}

export function removeAll(domainId: number): void {
  db.query("DELETE FROM things WHERE domain_id = ?").run(domainId);
}

export function schemaVersion(name: string): unknown {
  return db.query("SELECT version FROM schema_versions WHERE name = ?").get(name);
}
