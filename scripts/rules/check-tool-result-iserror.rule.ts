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
 *   2. Walk up to the enclosing variable declaration (if any) to get the
 *      result binding name.
 *   3. Scan the enclosing function/block for `.content` property accesses
 *      on that binding.
 *   4. For each `.content` access, check whether the same scope contains
 *      an `isError` property access on the same binding OR a call to
 *      `unwrapToolResult`/`unwrapToolResultJson` with the binding as arg.
 *   5. Report violations where `.content` is accessed without a guard.
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

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function getBindingName(callExpr: ts.CallExpression): string | undefined {
  const parent = callExpr.parent;
  if (ts.isAwaitExpression(parent)) {
    return getBindingName(parent as unknown as ts.CallExpression);
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function hasPropertyAccessInScope(scope: ts.Node, bindingName: string, propertyName: string): boolean {
  let found = false;
  walk(scope, (n) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === bindingName &&
      n.name.text === propertyName
    ) {
      found = true;
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === bindingName &&
      n.expression.name.text === propertyName
    ) {
      found = true;
    }
  });
  return found;
}

function hasUnwrapCall(scope: ts.Node, bindingName: string): boolean {
  let found = false;
  walk(scope, (n) => {
    if (found) return;
    if (!ts.isCallExpression(n)) return;
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

function findContentAccesses(scope: ts.Node, bindingName: string): ts.PropertyAccessExpression[] {
  const accesses: ts.PropertyAccessExpression[] = [];
  walk(scope, (n) => {
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

    ts.forEachChild(sf, function bindParents(node: ts.Node) {
      node.parent = node.parent ?? sf;
      ts.forEachChild(node, (child) => {
        (child as { parent: ts.Node }).parent = node;
        bindParents(child);
      });
    });

    const callToolCalls = ast.callsTo("callTool");

    for (const call of callToolCalls) {
      const bindingName = getBindingName(call);
      if (!bindingName) continue;

      const scope = getEnclosingBlock(call);

      if (hasUnwrapCall(scope, bindingName)) continue;

      if (!hasPropertyAccessInScope(scope, bindingName, "content")) continue;

      if (hasPropertyAccessInScope(scope, bindingName, "isError")) continue;

      const contentAccesses = findContentAccesses(scope, bindingName);
      if (contentAccesses.length > 0) {
        const pos = ast.positionOf(contentAccesses[0]);
        const line = sf.text.split("\n")[pos.line - 1] ?? "";
        violated(pos.line, pos.column, line.trim());
      }
    }
  },
};

export default rule;
