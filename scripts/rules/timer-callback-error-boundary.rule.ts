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

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const TIMER_NAMES = new Set(["setTimeout", "setInterval"]);

type Callback = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

/**
 * A callback body is "fully wrapped" if every statement is a try/catch.
 * `try-finally` without a catch clause is NOT sufficient — the exception
 * still propagates after the finally block runs. Any statement outside a
 * try/catch can propagate an unhandled throw; use safeSetTimeout/safeSetInterval
 * instead of relying on this shape check for callbacks with setup code.
 */
function isCallbackFullyWrapped(body: TSESTree.BlockStatement): boolean {
  return body.body.every((s) => s.type === "TryStatement" && s.handler !== null);
}

/**
 * Only expression-bodied arrows whose body is a direct identifier call are
 * exempt inside `new Promise()`. This matches the `() => reject(...)` /
 * `() => resolve(...)` pattern where the callee is a plain identifier (not
 * a method call or other expression). `reject`/`resolve` themselves cannot
 * throw, so the callback is safe. Any other expression (method calls,
 * binary ops, etc.) can throw and is NOT exempt.
 *
 * Block-body callbacks are never exempt regardless of Promise constructor
 * context — the constructor's synchronous try/catch does not protect
 * callbacks scheduled by setTimeout/setInterval.
 */
function isExpressionBodyInsidePromiseConstructor(call: TSESTree.Node, callback: Callback): boolean {
  const body = callback.body;
  if (body.type === "BlockStatement") return false;
  // Only a direct identifier call is safe: () => reject(...) / () => resolve(...)
  if (body.type !== "CallExpression" || body.callee.type !== "Identifier") return false;
  for (let n: TSESTree.Node | undefined = call; n; n = n.parent) {
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Promise") return true;
  }
  return false;
}

export default {
  id: "timer-callback-error-boundary",
  type: "check",
  category: "architecture",
  ast: true,
  scold:
    "setTimeout/setInterval callback in daemon code has no error boundary — an unhandled throw can crash the process",
  guidance: [
    "use safeSetTimeout/safeSetInterval from safe-timers (adjust relative import to your file depth)",
    "or wrap the callback body in try { … } catch (e) { console.error(…) }",
  ],
  documentation: "#2265",
  tests: "exclude",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/daemon/src/")) return ctx.skipped();

    const lines = file.content.split("\n");
    walk(ctx.ast().program, (call) => {
      if (call.type !== "CallExpression") return;
      const expr = call.callee;
      let name: string | undefined;
      if (expr.type === "Identifier") name = expr.name;
      else if (expr.type === "MemberExpression" && !expr.computed && expr.property.type === "Identifier") {
        name = expr.property.name;
      }
      if (!name || !TIMER_NAMES.has(name)) return;

      const callback = call.arguments[0];
      if (!callback) return;
      if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return;

      if (isExpressionBodyInsidePromiseConstructor(call, callback)) return;

      if (callback.body.type === "BlockStatement" && isCallbackFullyWrapped(callback.body)) return;
      // Expression-bodied arrows (e.g. `setTimeout(() => doThing(), ms)`)
      // have no try/catch — flag them.

      const { line, column } = call.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
