import ts from "typescript";

import type { CheckRule } from "./_engine/rule";

const CONNECTION_ARG = /\b(?:first|last)\s*:\s*\d+/g;

function hasPageInfoInBlock(text: string, fromIndex: number): boolean {
  let depth = 0;
  let foundOpen = false;
  for (let i = fromIndex; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
      foundOpen = true;
    } else if (text[i] === "}") {
      depth--;
      if (foundOpen && depth === 0) {
        const block = text.slice(fromIndex, i + 1);
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
    "GraphQL query uses first:/last: connection argument without selecting pageInfo { hasNextPage } — results may be silently truncated",
  guidance: [
    "add `pageInfo { hasNextPage endCursor }` to every connection that uses `first:` or `last:`",
    "or use `paginateGql(...)` from gh-client which requires and consumes pageInfo automatically",
    "if a single page is genuinely sufficient, still select pageInfo and assert/log when hasNextPage is true",
  ],
  documentation: "#2266",
  appliesToTests: false,
  check({ ast, violated }) {
    const templates = [...ast.find(ts.isNoSubstitutionTemplateLiteral), ...ast.find(ts.isTemplateExpression)];

    for (const node of templates) {
      const text = node.getText(ast.sourceFile);
      CONNECTION_ARG.lastIndex = 0;
      if (!CONNECTION_ARG.test(text)) continue;

      CONNECTION_ARG.lastIndex = 0;
      let match: RegExpExecArray | null = CONNECTION_ARG.exec(text);
      while (match) {
        if (!hasPageInfoInBlock(text, match.index)) {
          const { line, column } = ast.positionOf(node);
          const firstLine = (text.split("\n")[0] ?? "").trim();
          violated(line, column, firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine);
          break;
        }
        match = CONNECTION_ARG.exec(text);
      }
    }
  },
};

export default rule;
