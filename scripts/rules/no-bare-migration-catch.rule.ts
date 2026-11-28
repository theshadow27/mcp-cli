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

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const ALTER_ADD_COL = /alter\s+table\s+\S+\s+add\s+column\s+/i;

/**
 * Does `block` contain a throw? Nested function and class bodies do not count: a throw inside
 * one does not synchronously re-throw the catch variable (false negative otherwise).
 */
function containsThrow(block: TSESTree.BlockStatement): boolean {
  let found = false;
  let skipUntil = 0;
  walk(block, (node) => {
    if (found || node.range[0] < skipUntil) return;
    if (node.type === "ThrowStatement") {
      found = true;
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      skipUntil = node.range[1];
    }
  });
  return found;
}

/**
 * Every string and template in `node`, as source text. A template keeps its `${}` holes, which
 * ALTER_ADD_COL's `\S+` reads as an ordinary table name.
 */
function sqlTexts(node: TSESTree.Node, content: string): string[] {
  const texts: string[] = [];
  walk(node, (n) => {
    if (n.type === "TemplateLiteral") texts.push(content.slice(...n.range));
    else if (n.type === "Literal" && typeof n.value === "string") texts.push(n.value);
  });
  return texts;
}

export default {
  id: "no-bare-migration-catch",
  type: "check",
  category: "architecture",
  ast: true,
  tests: "exclude",
  scold: "ALTER TABLE … ADD COLUMN wrapped in a bare catch — use addColumnIfMissing() or re-throw non-duplicate errors",
  guidance: [
    "use addColumnIfMissing(db, table, column, ddl) — idempotent by PRAGMA table_info, no catch needed",
    "if you must catch, narrow to the duplicate-column error and re-throw everything else",
    "a bare catch silently swallows SQLITE_BUSY, disk-full, and corruption",
  ],
  documentation: "#2263",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/")) return ctx.skipped();

    walk(ctx.ast().program, (node) => {
      if (node.type !== "TryStatement" || !node.handler) return;
      if (!sqlTexts(node.block, file.content).some((text) => ALTER_ADD_COL.test(text))) return;
      if (containsThrow(node.handler.body)) return;

      const { line, column } = node.handler.loc.start;
      ctx.violated(line, column + 1, file.content.split("\n")[line - 1]?.trim() ?? "");
    });
    return ctx.checked();
  },
} satisfies Rule;
