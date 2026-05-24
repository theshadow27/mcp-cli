/**
 * Rule: test-unguarded-narrowing
 *
 * Flag tests that check a discriminated-union sub-field inside an
 * `if (x.disc === lit)` guard without first asserting the discriminant.
 * A regression that returns the wrong variant silently skips the block
 * and the test passes vacuously.
 *
 * Uses the TS AST matcher from #2267 for reliable detection.
 *
 * Sources: #1990 (×3), #2049.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function isLiteralNode(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return "";
}

function collectAll<T extends ts.Node>(root: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const results: T[] = [];
  function walk(n: ts.Node): void {
    if (guard(n)) results.push(n);
    ts.forEachChild(n, walk);
  }
  walk(root);
  return results;
}

function isInsideNode(inner: ts.Node, outer: ts.Node, sf: ts.SourceFile): boolean {
  return outer.getStart(sf) <= inner.getStart(sf) && outer.getEnd() >= inner.getEnd();
}

function isDiscAssertCall(
  call: ts.CallExpression,
  objText: string,
  discProp: string,
  litVal: string,
  sf: ts.SourceFile,
): boolean {
  // expect(obj.disc).toBe(lit) or .toEqual(lit)
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (method !== "toBe" && method !== "toEqual") return false;

  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver)) return false;
  if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== "expect") return false;

  const expectArg = receiver.arguments[0];
  if (!expectArg || !ts.isPropertyAccessExpression(expectArg)) return false;
  if (expectArg.expression.getText(sf) !== objText) return false;
  if (expectArg.name.text !== discProp) return false;

  const assertArg = call.arguments[0];
  if (!assertArg) return false;
  return literalText(assertArg) === litVal;
}

const rule: CheckRule = {
  id: "test-unguarded-narrowing",
  kind: "check",
  scold:
    "expect() inside if-guard without asserting the discriminant — test passes vacuously if the wrong variant is returned",
  guidance: [
    'assert the discriminant first: expect(result.kind).toBe("expected") before narrowing',
    'or remove the if-guard and assert directly: expect(result).toEqual({ kind: "expected", ... })',
  ],
  documentation: "#2247",
  appliesToTests: true,
  check({ file, violated, ast }) {
    if (!file.isTest) return;

    const sf = ast.sourceFile;
    const ifStmts = ast.find(ts.isIfStatement);

    for (const ifStmt of ifStmts) {
      const cond = ifStmt.expression;
      if (!ts.isBinaryExpression(cond)) continue;
      if (cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue;

      let propAccess: ts.PropertyAccessExpression | undefined;
      let litNode: ts.Node | undefined;

      if (ts.isPropertyAccessExpression(cond.left) && isLiteralNode(cond.right)) {
        propAccess = cond.left;
        litNode = cond.right;
      } else if (ts.isPropertyAccessExpression(cond.right) && isLiteralNode(cond.left)) {
        propAccess = cond.right;
        litNode = cond.left;
      }

      if (!propAccess || !litNode) continue;

      const objText = propAccess.expression.getText(sf);
      const discProp = propAccess.name.text;
      const litVal = literalText(litNode);

      const thenBlock = ifStmt.thenStatement;
      const thenCalls = collectAll(thenBlock, ts.isCallExpression);

      const hasSubFieldExpect = thenCalls.some((call) => {
        if (!ts.isIdentifier(call.expression) || call.expression.text !== "expect") return false;
        const arg = call.arguments[0];
        if (!arg || !ts.isPropertyAccessExpression(arg)) return false;
        return arg.expression.getText(sf) === objText;
      });

      if (!hasSubFieldExpect) continue;

      const encFn = ts.findAncestor(
        ifStmt,
        (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n),
      );
      if (!encFn) continue;

      const fnCalls = collectAll(encFn, ts.isCallExpression);
      const hasDiscAssertOutsideGuard = fnCalls.some((call) => {
        if (!isDiscAssertCall(call, objText, discProp, litVal, sf)) return false;
        // Assertion inside the if-guard body is vacuous — already guarded by
        // the same condition. Only assertions outside the if count.
        return !isInsideNode(call, ifStmt, sf);
      });

      if (!hasDiscAssertOutsideGuard) {
        const pos = ast.positionOf(ifStmt);
        const condText = cond.getText(sf);
        violated(pos.line, pos.column, `if (${condText}) { expect(${objText}.…)… }`);
      }
    }
  },
};

export default rule;
