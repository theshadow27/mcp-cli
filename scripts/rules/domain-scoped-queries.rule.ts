/**
 * Rule: domain-scoped-queries
 *
 * In a module marked `@domain-partitioned`, every SQL statement that touches a table
 * declared with a `domain_id` column must constrain `domain_id`.
 *
 * Why this is a rule and not a review comment: the #3019 epic partitions the daemon's
 * tables by domain, and the failure mode is not a crash. A `SELECT … WHERE pr_number = 42`
 * that forgets `domain_id` returns *an* answer — an arbitrary domain's row — and a
 * forgotten `domain_id` on an INSERT writes a row that belongs to nobody. #3034's audit
 * found exactly that: `work_item_transitions.domain_id` had no writer at all, so every
 * transition row said `domain_id = 0` and `countDomainDependents` under-reported by the
 * whole table. Nothing failed; the number was just wrong.
 *
 * Two things this rule deliberately does NOT do:
 *
 * - **It maintains no list of partitioned tables.** The set is derived from the
 *   `CREATE TABLE … domain_id …` statements in the scanned sources. A fourth hand-copied
 *   list of the partitioned tables is how the first three drifted.
 * - **It does not scan the whole repo.** A module opts in with the `@domain-partitioned`
 *   marker in its header comment. Most of the daemon's partitioned tables (`mail`,
 *   `agent_sessions`, `alias_state`) still have unscoped readers on purpose — their
 *   behaviour lands in later sub-issues of #3021. The marker is the ratchet: a module
 *   adds it the sprint its behaviour is scoped, and cannot regress afterwards.
 */

import ts from "typescript";
import type { FileMeta } from "./_engine/file-loader";
import type { CheckRule, RuleContext } from "./_engine/rule";

/**
 * Marker that opts a module into this rule.
 *
 * A line comment, not a JSDoc tag: the rule-fixture loader blanks JSDoc blocks so that
 * prose in a fixture's explanation cannot trip pattern rules, which would make a
 * JSDoc-only marker untestable — the fixtures would silently pass whatever the rule did.
 */
const OPT_IN = "@domain-partitioned";

/** `CREATE TABLE [IF NOT EXISTS] <name> ( … )` — captures the name and the column body. */
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;?/gi;

/** A statement worth checking. `WITH`/`CREATE` are schema or read-only plumbing. */
const IS_DML = /\b(?:select|insert\s+into|update|delete\s+from)\b/i;

/** Table referenced by a DML statement. */
function tablesReferenced(sql: string, partitioned: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const table of partitioned) {
    const re = new RegExp(String.raw`\b(?:from|into|update|join)\s+${table}\b`, "i");
    if (re.test(sql)) hits.push(table);
  }
  return hits;
}

/** Every string literal and template in a file, with the line each starts on. */
function sqlStrings(file: FileMeta, ast: RuleContext["ast"]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      out.push({ text: node.getText(ast.sourceFile), line: ast.positionOf(node).line });
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ast.sourceFile, visit);
  return out;
}

/**
 * Tables declared with a `domain_id` column, across every loaded file.
 *
 * Cross-file on purpose: a marked module may query a table another module declares.
 */
function partitionedTables(files: Map<string, FileMeta>): Set<string> {
  const tables = new Set<string>();
  for (const f of files.values()) {
    if (!f.relPath.startsWith("packages/")) continue;
    for (const match of f.content.matchAll(CREATE_TABLE)) {
      const [, name, body] = match;
      if (/\bdomain_id\b/i.test(body)) tables.add(name.toLowerCase());
    }
  }
  return tables;
}

const rule: CheckRule = {
  id: "domain-scoped-queries",
  kind: "check",
  appliesToTests: false,
  scold: "SQL against a domain-partitioned table with no domain_id predicate",
  guidance: [
    "add `domain_id = ?` to the WHERE clause, or `domain_id` to the INSERT column list",
    "reads: an unscoped lookup by a per-domain unique key returns an arbitrary domain's row, not an error",
    "writes: an unscoped INSERT lands in the `domain_id = 0` sentinel partition and is invisible to its own domain",
    "prefer routing the query through a domain-bound handle (WorkItemDb.forDomain) so the predicate cannot be omitted",
    "the module opted in via the `@domain-partitioned` marker in its header — remove the marker only to un-scope the module",
  ],
  documentation: "#3037",
  // No `anchors`: this rule globs for CREATE TABLE DDL rather than peering at one named
  // sibling, and the marked module declares its own tables — so a narrowed `--filter` that
  // loads the marked file always loads its DDL with it.
  check({ file, files, violated, ast, checked }) {
    if (!file.relPath.startsWith("packages/")) return;
    if (!file.content.includes(OPT_IN)) return;

    const partitioned = partitionedTables(files);
    if (partitioned.size === 0) return;
    checked();

    for (const { text, line } of sqlStrings(file, ast)) {
      if (!IS_DML.test(text)) continue;
      // A CREATE TABLE/INDEX block is schema, not a query. Its inner SELECT-less body
      // can still match IS_DML via a column named e.g. `updated_at`, so skip it wholesale.
      if (/create\s+(?:table|unique\s+index|index)/i.test(text)) continue;
      const hits = tablesReferenced(text, partitioned);
      if (hits.length === 0) continue;
      if (/\bdomain_id\b/i.test(text)) continue;
      violated(line, 1, `${hits.join(", ")}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  },
};

export default rule;
