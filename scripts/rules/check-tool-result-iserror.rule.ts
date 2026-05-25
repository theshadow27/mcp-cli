/**
 * Rule: check-tool-result-iserror
 *
 * Flag `callTool()` results whose `.content` is accessed without a
 * preceding `isError` check and without going through `unwrapToolResult`
 * or `unwrapToolResultJson`. This catches the "silent data loss" bug
 * where an error response is parsed as valid data.
 *
 * Detection strategy (AST):
 *   1. Find all `callTool(...)` call expressions.
 *   2. Walk up through expression wrappers (await, as, parens, !)
 *      to the enclosing VariableDeclaration to get the result binding.
 *   3. Scan the enclosing block for `.content` property accesses on
 *      that binding (excluding nested function bodies).
 *   4. For each `.content` access, require a *preceding* `isError`
 *      property access (by source position) or an `unwrapToolResult`
 *      call. "Same scope but after" does not count as a guard.
 *   5. Report the first unguarded `.content` access as a violation.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function getEnclosingBlock(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (parent) {
    if (
      ts.isBlock(parent) ||
      ts.isSourceFile(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return node.getSourceFile();
}

function isNestedFunction(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

function walkSkippingNestedFunctions(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (isNestedFunction(child)) return;
    walkSkippingNestedFunctions(child, visit);
  });
}

function isExpressionWrapper(node: ts.Node): boolean {
  return (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function getBindingName(node: ts.Node): string | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    if (isExpressionWrapper(current)) {
      current = current.parent;
      continue;
    }
    break;
  }
  return undefined;
}

function getDestructuredContentElement(node: ts.Node): ts.BindingElement | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isObjectBindingPattern(current.name)) {
      for (const el of current.name.elements) {
        const name = el.propertyName ?? el.name;
        if (ts.isIdentifier(name) && name.text === "content") {
          return el;
        }
      }
      return undefined;
    }
    if (isExpressionWrapper(current)) {
      current = current.parent;
      continue;
    }
    break;
  }
  return undefined;
}

function getInlineContentAccess(node: ts.Node): ts.PropertyAccessExpression | undefined {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (isExpressionWrapper(parent)) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === "content" && parent.expression === current) {
      return parent;
    }
    break;
  }
  return undefined;
}

function hasUnwrapCallBefore(scope: ts.Node, bindingName: string, beforePos: number): boolean {
  let found = false;
  walkSkippingNestedFunctions(scope, (n) => {
    if (found) return;
    if (!ts.isCallExpression(n)) return;
    if (n.getStart() >= beforePos) return;
    const callee = n.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name !== "unwrapToolResult" && name !== "unwrapToolResultJson") return;
    for (const arg of n.arguments) {
      if (ts.isIdentifier(arg) && arg.text === bindingName) {
        found = true;
      }
    }
  });
  return found;
}

function hasIsErrorCheckBefore(scope: ts.Node, bindingName: string, beforePos: number): boolean {
  let found = false;
  walkSkippingNestedFunctions(scope, (n) => {
    if (found) return;
    if (n.getStart() >= beforePos) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === bindingName &&
      n.name.text === "isError"
    ) {
      found = true;
    }
  });
  return found;
}

function findContentAccesses(scope: ts.Node, bindingName: string): ts.PropertyAccessExpression[] {
  const accesses: ts.PropertyAccessExpression[] = [];
  walkSkippingNestedFunctions(scope, (n) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === bindingName &&
      n.name.text === "content"
    ) {
      accesses.push(n);
    }
  });
  return accesses;
}

const rule: CheckRule = {
  id: "check-tool-result-iserror",
  kind: "check",
  scold:
    "callTool() result .content accessed without checking isError — error responses will be silently parsed as data",
  guidance: [
    "use unwrapToolResult(result) or unwrapToolResultJson<T>(result) from @mcp-cli/core",
    "alternatively, check result.isError before accessing result.content",
    "see packages/core/src/mcp-result.ts for the shared helper",
  ],
  documentation: "#2271",
  appliesToTests: false,
  check({ ast, violated }) {
    const sf = ast.sourceFile;
    const lines = sf.text.split("\n");
    const callToolCalls = ast.callsTo("callTool");

    for (const call of callToolCalls) {
      const bindingName = getBindingName(call);
      if (!bindingName) {
        const destructuredEl = getDestructuredContentElement(call);
        if (destructuredEl) {
          const pos = ast.positionOf(destructuredEl);
          const line = lines[pos.line - 1] ?? "";
          violated(pos.line, pos.column, line.trim());
          continue;
        }
        const inlineAccess = getInlineContentAccess(call);
        if (inlineAccess) {
          const pos = ast.positionOf(inlineAccess);
          const line = lines[pos.line - 1] ?? "";
          violated(pos.line, pos.column, line.trim());
        }
        continue;
      }

      const scope = getEnclosingBlock(call);
      const contentAccesses = findContentAccesses(scope, bindingName);

      for (const access of contentAccesses) {
        const accessPos = access.getStart();

        if (hasUnwrapCallBefore(scope, bindingName, accessPos)) continue;
        if (hasIsErrorCheckBefore(scope, bindingName, accessPos)) continue;

        const pos = ast.positionOf(access);
        const line = lines[pos.line - 1] ?? "";
        violated(pos.line, pos.column, line.trim());
        break;
      }
    }
  },
};

export default rule;
