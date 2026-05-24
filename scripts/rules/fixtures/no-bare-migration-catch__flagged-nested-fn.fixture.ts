/**
 * @rule no-bare-migration-catch
 * @expect 1
 * @path packages/daemon/src/db/state.ts
 *
 * A catch block that defines a nested function containing a throw does NOT
 * synchronously re-throw the error — the throw is dead code unless the function
 * is called. The rule must stop traversal at function boundaries and flag this.
 */

import type { Database } from "bun:sqlite";

declare const db: Database;

export function migrate(): void {
  try {
    db.run("ALTER TABLE work_items ADD COLUMN scope TEXT");
  } catch (e) {
    // Defines a function that throws, but never calls it — error is still swallowed.
    function doRethrow() {
      throw e;
    }
    void doRethrow; // reference to suppress unused-var — but never called
  }
}
