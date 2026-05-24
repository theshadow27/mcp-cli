/**
 * @rule no-bare-migration-catch
 * @expect 1
 * @path packages/daemon/src/db/state.ts
 *
 * A bare catch around ALTER TABLE ADD COLUMN expressed as a template literal
 * (the pattern already present in packages/daemon/src/db/state.ts ~line 139)
 * must also be flagged — stringLiterals() misses TemplateExpression nodes.
 */

import type { Database } from "bun:sqlite";

declare const db: Database;
declare const col: string;
declare const def: string;

export function migrate(): void {
  try {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} ${def}`);
  } catch {}
}
