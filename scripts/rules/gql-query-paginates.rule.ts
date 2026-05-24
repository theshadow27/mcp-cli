import ts from "typescript";

import type { CheckRule } from "./_engine/rule";

/**
 * Advance past the closing ')' of the GQL field's argument list.
 *
 * `match.index` lands inside the arg list (at `first:`). Any `{...}` before
 * the closing ')' is an input-object argument, not the selection set.
 * Counting braces from inside the arg list would misidentify those as the
 * selection set and produce false positives.
 */
function findSelectionSetStart(text: string, fromIndex: number): number {
  let parenDepth = 0;
  for (let i = fromIndex; i < text.length; i++) {
    if (text[i] === "(") parenDepth++;
    else if (text[i] === ")") {
      if (parenDepth === 0) return i + 1; // just past the field's closing ')'
      parenDepth--;
    }
  }
  return fromIndex;
}

function hasPageInfoInBlock(text: string, fromIndex: number): boolean {
  const start = findSelectionSetStart(text, fromIndex);
  let depth = 0;
  let foundOpen = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
      foundOpen = true;
    } else if (text[i] === "}") {
      depth--;
      if (foundOpen && depth === 0) {
        const block = text.slice(start, i + 1);
        return /pageInfo\s*\{[^}]*hasNextPage/s.test(block);
      }
    }
  }
  return false;
}

const rule: CheckRule = {
  id: "gql-query-paginates",
  kind: "check",
  scold:
    "GraphQL query uses first: connection argument without selecting pageInfo { hasNextPage } — results may be silently truncated",
  guidance: [
    "add `pageInfo { hasNextPage endCursor }` to every connection that uses `first:`",
    "or use `paginateGql(...)` from gh-client which requires and consumes pageInfo automatically",
    "if a single page is genuinely sufficient, still select pageInfo and assert/log when hasNextPage is true",
    "`last:` connections (head/tail queries) are not flagged — only forward-paginating `first:` connections are checked",
  ],
  documentation: "#2266",
  appliesToTests: false,
  check({ ast, violated }) {
    const templates = [...ast.find(ts.isNoSubstitutionTemplateLiteral), ...ast.find(ts.isTemplateExpression)];

    for (const node of templates) {
      const text = node.getText(ast.sourceFile);
      for (const match of text.matchAll(/\bfirst\s*:\s*\d+/g)) {
        if (!hasPageInfoInBlock(text, match.index ?? 0)) {
          const { line, column } = ast.positionOf(node);
          const firstLine = (text.split("\n")[0] ?? "").trim();
          violated(line, column, firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine);
          break;
        }
      }
    }
  },
};

export default rule;
