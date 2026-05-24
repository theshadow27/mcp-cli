/**
 * Rule: no-bare-migration-catch
 *
 * Flags a try/catch where the try block contains an `ALTER TABLE … ADD COLUMN`
 * SQL string and the catch block has no ThrowStatement. This pattern swallows
 * SQLITE_BUSY, disk-full, and corruption errors — the column may be absent
 * and the daemon continues on a half-migrated schema.
 *
 * Fix: use addColumnIfMissing(db, table, column, ddl) which checks
 * PRAGMA table_info first and propagates all errors. If you must catch,
 * narrow to the duplicate-column error and re-throw everything else.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const ALTER_ADD_COL = /alter\s+table\s+\S+\s+add\s+column\s+/i;

function containsThrow(block: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return found;
}

const rule: CheckRule = {
  id: "no-bare-migration-catch",
  kind: "check",
  appliesToTests: false,
  scold: "ALTER TABLE … ADD COLUMN wrapped in a bare catch — use addColumnIfMissing() or re-throw non-duplicate errors",
  guidance: [
    "use addColumnIfMissing(db, table, column, ddl) — idempotent by PRAGMA table_info, no catch needed",
    "if you must catch, narrow to the duplicate-column error and re-throw everything else",
    "a bare catch silently swallows SQLITE_BUSY, disk-full, and corruption",
  ],
  documentation: "#2263",
  check({ file, violated, ast }) {
    if (!file.relPath.startsWith("packages/")) return;

    const tryStmts = ast.find(ts.isTryStatement);
    for (const stmt of tryStmts) {
      if (!stmt.catchClause) continue;

      const sqlStrings = ast.stringLiterals(stmt.tryBlock);
      if (!sqlStrings.some((s) => ALTER_ADD_COL.test(s))) continue;

      if (!containsThrow(stmt.catchClause.block)) {
        const { line, column } = ast.positionOf(stmt.catchClause);
        violated(line, column, "catch without re-throw around ALTER TABLE … ADD COLUMN");
      }
    }
  },
};

export default rule;
