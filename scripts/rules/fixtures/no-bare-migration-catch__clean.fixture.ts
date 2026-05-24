/**
 * @rule no-bare-migration-catch
 * @expect 0
 * @path packages/daemon/src/db/state.ts
 *
 * Using addColumnIfMissing() — idempotent by PRAGMA table_info, no catch needed.
 * A try/catch with ALTER TABLE ADD COLUMN but WITH a re-throw is also clean.
 */

import type { Database } from "bun:sqlite";
import { addColumnIfMissing } from "./migration";

declare const db: Database;

export function migrate(): void {
  addColumnIfMissing(db, "work_items", "scope", "ALTER TABLE work_items ADD COLUMN scope TEXT");
  addColumnIfMissing(db, "work_items", "label", "ALTER TABLE work_items ADD COLUMN label TEXT");
}

export function migrateWithNarrowCatch(): void {
  try {
    db.run("ALTER TABLE work_items ADD COLUMN scrutiny TEXT");
  } catch (e) {
    if (e instanceof Error && e.message.includes("duplicate column")) return;
    throw e;
  }
}
