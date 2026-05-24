/**
 * Rule: timer-callback-error-boundary
 *
 * In daemon code, a setTimeout/setInterval callback that throws produces an
 * unhandled rejection (if async) or unhandled exception — either can crash
 * the daemon. This rule flags callbacks that are not wrapped in try/catch.
 *
 * Safe alternatives:
 *   - Use `safeSetTimeout` / `safeSetInterval` from `safe-timers`
 *   - Wrap the callback body in `try { … } catch { … }`
 *
 * Scoped to `packages/daemon/src/**` — CLI and core packages have
 * different error propagation models.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const TIMER_NAMES = new Set(["setTimeout", "setInterval"]);

function isCallbackFullyWrapped(body: ts.Block): boolean {
  const stmts = body.statements;
  if (stmts.length === 0) return true;
  if (stmts.length === 1 && stmts[0] && ts.isTryStatement(stmts[0])) return true;
  return false;
}

function isInsidePromiseConstructor(node: ts.Node): boolean {
  return (
    ts.findAncestor(node, (n) => {
      if (!ts.isNewExpression(n)) return false;
      return ts.isIdentifier(n.expression) && n.expression.text === "Promise";
    }) !== undefined
  );
}

const rule: CheckRule = {
  id: "timer-callback-error-boundary",
  kind: "check",
  scold:
    "setTimeout/setInterval callback in daemon code has no error boundary — an unhandled throw can crash the process",
  guidance: [
    "use safeSetTimeout/safeSetInterval from safe-timers (adjust relative import to your file depth)",
    "or wrap the callback body in try { … } catch (e) { console.error(…) }",
  ],
  documentation: "#2265",
  check({ file, ast, violated }) {
    if (!file.relPath.startsWith("packages/daemon/src/")) return;
    if (file.isTest) return;

    const calls = ast.find(ts.isCallExpression);
    for (const call of calls) {
      const expr = call.expression;
      let name: string | undefined;
      if (ts.isIdentifier(expr)) {
        name = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        name = expr.name.text;
      }

      if (!name || !TIMER_NAMES.has(name)) continue;

      const callback = call.arguments[0];
      if (!callback) continue;

      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;

      if (isInsidePromiseConstructor(call)) continue;

      if (ts.isBlock(callback.body)) {
        if (isCallbackFullyWrapped(callback.body)) continue;
      }
      // Expression-bodied arrows (e.g. `setTimeout(() => doThing(), ms)`)
      // have no try/catch — flag them.

      const pos = ast.positionOf(call);
      const line = file.content.split("\n")[pos.line - 1] ?? "";
      violated(pos.line, pos.column, line.trim());
    }
  },
};

export default rule;
