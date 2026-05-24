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

/**
 * Return true iff the GQL connection whose arg list contains `fromIndex`
 * has `pageInfo { hasNextPage }` as a **direct child** of its selection set.
 *
 * Critically, a `pageInfo { hasNextPage }` belonging to an *inner* nested
 * connection (depth > 1) must not satisfy this check — the invariant is
 * that the *queried* connection itself selects pageInfo, not some descendant.
 */
function hasPageInfoInBlock(text: string, fromIndex: number): boolean {
  const start = findSelectionSetStart(text, fromIndex);
  let depth = 0;

  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth <= 0) return false; // exited the connection's selection set
    } else if (depth === 1 && text[i] === "p" && text.slice(i, i + 8) === "pageInfo" && !/\w/.test(text[i + 8] ?? "")) {
      // `pageInfo` found as a direct child — check it's followed by { hasNextPage }
      let j = i + 8;
      while (j < text.length && /[ \t\r\n]/.test(text[j] ?? "")) j++;
      if ((text[j] ?? "") !== "{") continue; // no block follows — keep scanning
      // Scan the pageInfo block body for `hasNextPage`
      let innerDepth = 1;
      const bodyStart = j + 1;
      j++;
      while (j < text.length && innerDepth > 0) {
        if (text[j] === "{") innerDepth++;
        else if (text[j] === "}") innerDepth--;
        j++;
      }
      if (/\bhasNextPage\b/.test(text.slice(bodyStart, j - 1))) return true;
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
