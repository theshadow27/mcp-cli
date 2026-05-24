/**
 * Rule: no-error-message-sniffing
 *
 * Flags `.message.startsWith(...)` / `.message.includes(...)` /
 * `.message.match(...)` when the call result directly drives control flow
 * (used as the condition of an `if`, `while`, `? :`, or `switch`).
 *
 * Why: error message text is prose, not a stable contract. The moment a
 * message is reworded the branch silently stops firing. The alternative is
 * `instanceof TypedError` or a structured `code` field for branching, and
 * `getErrorMessage(err)` from `packages/core` for human-facing display.
 *
 * The AST walk distinguishes control-flow conditions from display paths:
 *   - flagged: `if (err.message.includes("timeout")) { ... }`
 *   - clean:   `log(getErrorMessage(err))` / `console.error(err.message)`
 */

import ts from "typescript";
import type { CheckRule, Violated } from "./_engine/rule";

const SNIFF_METHODS = new Set(["startsWith", "includes", "match", "matchAll"]);

function isMessageSniffCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    SNIFF_METHODS.has(node.expression.name.text) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "message"
  );
}

function scanCondition(
  condition: ts.Node,
  sourceFile: ts.SourceFile,
  positionOf: (n: ts.Node) => { line: number; column: number },
  violated: Violated,
): void {
  if (isMessageSniffCall(condition)) {
    const pos = positionOf(condition);
    const snippet = sourceFile.text.slice(condition.getStart(sourceFile), condition.end).trim();
    violated(pos.line, pos.column, snippet);
  }
  ts.forEachChild(condition, (child) => scanCondition(child, sourceFile, positionOf, violated));
}

const rule: CheckRule = {
  id: "no-error-message-sniffing",
  kind: "check",
  scold: "error message sniffed for control flow — use instanceof or a structured code field instead",
  guidance: [
    "branch on `instanceof TypedError` or check a typed `code` field — not on message text",
    "message prose is not a stable contract; it silently breaks when the text is reworded",
    "use `getErrorMessage(err)` from packages/core for human-facing display only",
    "rethrow with `{ cause: err }` to preserve the stack",
  ],
  documentation: "#2264",
  check({ ast, violated }) {
    const { sourceFile } = ast;
    const pos = (n: ts.Node) => ast.positionOf(n);

    function walk(node: ts.Node): void {
      if (ts.isIfStatement(node)) {
        scanCondition(node.expression, sourceFile, pos, violated);
        walk(node.thenStatement);
        if (node.elseStatement) walk(node.elseStatement);
        return;
      }
      if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        scanCondition(node.expression, sourceFile, pos, violated);
        walk(node.statement);
        return;
      }
      if (ts.isConditionalExpression(node)) {
        scanCondition(node.condition, sourceFile, pos, violated);
        walk(node.whenTrue);
        walk(node.whenFalse);
        return;
      }
      if (ts.isSwitchStatement(node)) {
        scanCondition(node.expression, sourceFile, pos, violated);
        walk(node.caseBlock);
        return;
      }
      if (ts.isCaseClause(node)) {
        scanCondition(node.expression, sourceFile, pos, violated);
        for (const stmt of node.statements) walk(stmt);
        return;
      }
      if (ts.isForStatement(node)) {
        if (node.condition) scanCondition(node.condition, sourceFile, pos, violated);
        if (node.initializer) walk(node.initializer);
        if (node.incrementor) walk(node.incrementor);
        walk(node.statement);
        return;
      }
      ts.forEachChild(node, walk);
    }

    ts.forEachChild(sourceFile, walk);
  },
};

export default rule;
