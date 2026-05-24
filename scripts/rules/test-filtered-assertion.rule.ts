/**
 * Rule: test-filtered-assertion
 *
 * Flag `expect(arr.filter(...)).toHaveLength(0)` and `.toEqual([])` in
 * tests.
 *
 * Why this is a trap: filtering is *subtractive*. You delete rows from the
 * collection before you ever look at it, so anything the filter removed can
 * no longer fail the assertion. A passing `filter(...).toHaveLength(0)` tells
 * you "the specific bad thing I searched for is absent" — it can never tell
 * you "the output is correct." The unexpected, the malformed, the entries you
 * didn't think to filter for: all silently pass.
 *
 * The fix is to assert against the *whole* collection, so anything you didn't
 * expect also fails.
 *
 * Sources: #2085, #2099.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function containsFilterCall(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "filter"
  ) {
    return true;
  }
  return ts.forEachChild(node, containsFilterCall) ?? false;
}

function isEmptyAssertion(name: string, args: ts.NodeArray<ts.Expression>): boolean {
  if (name === "toHaveLength" && args.length === 1) {
    const arg = args[0];
    return arg !== undefined && ts.isNumericLiteral(arg) && arg.text === "0";
  }
  if (name === "toEqual" && args.length === 1) {
    const arg = args[0];
    return arg !== undefined && ts.isArrayLiteralExpression(arg) && arg.elements.length === 0;
  }
  return false;
}

const rule: CheckRule = {
  id: "test-filtered-assertion",
  kind: "check",
  scold: "expect(collection.filter(...)) hides unexpected items — assert the whole collection instead",
  guidance: [
    "filtering is subtractive: whatever the filter removed can never fail the test, so .filter(...).toHaveLength(0) proves only that the bad thing you searched for is absent — never that the output is correct. Assert against the whole collection so unexpected items fail too.",
    "examples of doing it right (not exhaustive): expect(arr).toEqual([]) when it should be empty; expect(arr).not.toContainEqual(expect.objectContaining({ field: V })) when it legitimately holds other items (the filter predicate you wrote is the matcher); for a filter(p).map(f).toEqual([]), assert per element — for (const e of arr) expect(p(e)).toBe(false).",
  ],
  documentation: "#2247",
  appliesToTests: true,
  check({ file, ast, violated }) {
    const lines = file.content.split("\n");

    for (const call of ast.callsTo("toHaveLength").concat(ast.callsTo("toEqual"))) {
      if (!ts.isPropertyAccessExpression(call.expression)) continue;
      if (!isEmptyAssertion(call.expression.name.text, call.arguments)) continue;

      const receiver = call.expression.expression;

      const expectCall = findExpectAncestor(receiver);
      if (!expectCall) continue;
      if (expectCall.arguments.length !== 1) continue;

      if (containsFilterCall(expectCall.arguments[0])) {
        const pos = ast.positionOf(expectCall);
        violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
      }
    }
  },
};

function findExpectAncestor(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") {
    return node;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return findExpectAncestor(node.expression);
  }
  if (ts.isCallExpression(node)) {
    return findExpectAncestor(node.expression);
  }
  return undefined;
}

export default rule;
