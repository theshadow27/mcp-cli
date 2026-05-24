/**
 * @rule no-bare-migration-catch
 * @expect 1
 * @path packages/daemon/src/db/state.ts
 *
 * A bare catch around ALTER TABLE ADD COLUMN swallows SQLITE_BUSY, disk-full,
 * and corruption. One violation expected.
 */

import type { Database } from "bun:sqlite";

declare const db: Database;

export function migrate(): void {
  try {
    db.run("ALTER TABLE work_items ADD COLUMN scope TEXT");
  } catch {}
}
