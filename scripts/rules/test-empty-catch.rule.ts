/**
 * Rule: test-empty-catch
 *
 * Flag catch blocks in test files whose body contains no `expect(` call.
 * An empty or assertion-free catch swallows the failure the test claims
 * to verify — the test passes vacuously when the code throws.
 *
 * Uses AST CatchClause nodes (#2308 parent pointers) for scope-correct
 * detection — avoids regex scope-blindness on same-line or nested catches.
 *
 * Sources: #2194, #1879.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function containsExpectCall(node: ts.Node): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "expect") {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return found;
}

const rule: CheckRule = {
  id: "test-empty-catch",
  kind: "check",
  scold: "catch block in test has no expect() — swallows the failure the test should verify",
  guidance: [
    "assert the caught error: expect(e).toBeInstanceOf(SomeError) or expect((e as Error).message).toContain(...)",
    "or replace try/catch with expect(fn).toThrow(...)",
  ],
  documentation: "#2247",
  appliesToTests: true,
  check({ file, violated, ast }) {
    const sf = ast.sourceFile;
    const catchClauses = ast.find(ts.isCatchClause);

    for (const clause of catchClauses) {
      if (!containsExpectCall(clause.block)) {
        const pos = ast.positionOf(clause);
        const line = file.content.split("\n")[pos.line - 1] ?? "";
        violated(pos.line, pos.column, line.trim());
      }
    }
  },
};

export default rule;
