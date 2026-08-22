/**
 * @rule domain-scoped-queries
 * @expect 3
 * @path packages/daemon/src/db/things.ts
 *
 * Bypass tests for the rule itself.
 *
 * Every statement below satisfied the rule's FIRST implementation, which asked only whether
 * the token `domain_id` appeared anywhere in the statement. The token can satisfy a substring
 * test from a SELECT projection or an UPDATE ... SET clause while constraining nothing, so a
 * rule written to catch exactly this class of unscoped query reported clean on it (#3037
 * review R3).
 *
 * A rule that passes on its own target input is worse than no rule, because reviewers then
 * rely on it. These three cases exist so that can never silently return.
 *
 * The `@domain-partitioned` marker below is what opts this module into the rule.
 */

// @domain-partitioned

import type { Database } from "bun:sqlite";

declare const db: Database;

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS things (
      id        TEXT PRIMARY KEY,
      domain_id INTEGER NOT NULL DEFAULT 0,
      phase     TEXT,
      pr_number INTEGER
    );
  `);
}

/** domain_id in the projection — reads an arbitrary domain's row and returns its id. */
export function selectListBypass(prNumber: number): unknown {
  return db.query("SELECT id, domain_id, phase FROM things WHERE pr_number = ?").get(prNumber);
}

/** domain_id in the SET clause, assigned to itself — a no-op that satisfies a naive matcher. */
export function setClauseBypass(id: string): void {
  db.query("UPDATE things SET phase = ?, domain_id = domain_id WHERE id = ?").run("qa", id);
}

/** domain_id compared to itself inside the predicate — present, and constraining nothing. */
export function tautologyBypass(prNumber: number): unknown {
  return db.query("SELECT * FROM things WHERE domain_id = domain_id AND pr_number = ?").get(prNumber);
}
