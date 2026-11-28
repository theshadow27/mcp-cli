/**
 * Rule: no-cli-catch-warn
 *
 * `packages/command/src/` is the CLI binary. Unlike the daemon, it does not run
 * under `installDaemonLogCapture()`, so a `console.warn` inside a `.catch()`
 * handler writes directly to the user's terminal stderr — even for
 * unactionable bookkeeping failures that the user can do nothing about.
 * The daemon-side ring buffer absorbs warnings gracefully; the CLI does not.
 *
 * Fix: for fire-and-forget IPC bookkeeping, swallow silently. If the error is
 * actionable by the user, use `console.error`. To preserve debug visibility,
 * gate the warn behind an `if (process.env.DEBUG)` or `if (verbose)` check.
 *
 * Guard detection is AST-level and per-warn: each `console.warn` is checked
 * independently against its own enclosing IfStatement / ConditionalExpression
 * condition. A guard on one warn does not exempt other warns in the same
 * callback body.
 *
 * Limitations: `.catch(namedHandler)` reference forms are not checked — only
 * inline arrow functions and function expressions. `try { } catch { }` blocks
 * are also out of scope (tracked separately).
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

type Callback = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

const VERBOSE_NAMES = new Set(["verbose", "isVerbose", "verbosity"]);

/** `.catch(...)`, written `x.catch(` or `x["catch"](`. */
function isCatchCall(call: TSESTree.CallExpression): boolean {
  const callee = call.callee;
  if (callee.type !== "MemberExpression") return false;
  if (!callee.computed) return callee.property.type === "Identifier" && callee.property.name === "catch";
  return callee.property.type === "Literal" && callee.property.value === "catch";
}

function isConsoleWarn(node: TSESTree.Node): node is TSESTree.CallExpression {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "warn"
  );
}

/**
 * Returns true if `node` is a recognised verbosity guard:
 *   - `process.env.DEBUG` (exact property access chain)
 *   - an identifier whose name is `verbose`, `isVerbose`, or `verbosity`
 */
function isVerbosityGuardNode(node: TSESTree.Node): boolean {
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "DEBUG" &&
    node.object.type === "MemberExpression" &&
    !node.object.computed &&
    node.object.property.type === "Identifier" &&
    node.object.property.name === "env" &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process"
  ) {
    return true;
  }
  return node.type === "Identifier" && VERBOSE_NAMES.has(node.name);
}

/** Returns true if any node in the `condition` subtree is a verbosity guard. */
function conditionHasGuard(condition: TSESTree.Node): boolean {
  let found = false;
  walk(condition, (node) => {
    if (isVerbosityGuardNode(node)) found = true;
  });
  return found;
}

/**
 * Returns true if `warn` is directly dominated by a verbosity guard within `callback`. Walks up
 * the parent chain; stops at the callback boundary.
 *
 * A warn is guarded when it is inside the then-branch of an `if (guard) {}` statement or the
 * true-branch of a `guard ? ... : ...` expression, where the condition contains a recognised
 * verbosity guard node.
 */
function isGuardedWarn(warn: TSESTree.Node, callback: Callback): boolean {
  let current: TSESTree.Node = warn;
  let parent = warn.parent;
  while (parent && parent !== callback) {
    if (parent.type === "IfStatement" && current === parent.consequent && conditionHasGuard(parent.test)) return true;
    if (parent.type === "ConditionalExpression" && current === parent.consequent && conditionHasGuard(parent.test))
      return true;
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * True if `warn` belongs to `callback` itself: no function boundary (nested closure) and no other
 * `console.warn` call lies between them, so warns in inner closures are not attributed to the
 * outer catch callback and a warn's own arguments are not scanned for more warns.
 */
function ownedBy(warn: TSESTree.Node, callback: Callback): boolean {
  for (let p = warn.parent; p && p !== callback; p = p.parent) {
    if (p.type === "FunctionExpression" || p.type === "ArrowFunctionExpression") return false;
    if (isConsoleWarn(p)) return false;
  }
  return true;
}

export default {
  id: "no-cli-catch-warn",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold:
    "console.warn inside .catch() in packages/command/src/ — writes to terminal stderr even for unactionable bookkeeping failures",
  guidance: [
    "for fire-and-forget IPC calls, swallow silently in the catch handler",
    "if the warn is intentional, gate it behind `if (process.env.DEBUG)` or `if (verbose)`",
    "for errors that are actionable by the user, use console.error instead of console.warn",
    "the daemon ring buffer absorbs console.warn; the CLI binary writes it directly to the user's terminal",
  ],
  documentation: "#2474",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/command/src/")) return ctx.skipped();

    const lines = file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || !isCatchCall(node)) return;
      const callback = node.arguments[0];
      if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression") return;

      walk(callback, (inner) => {
        if (inner === callback || !isConsoleWarn(inner)) return;
        if (!ownedBy(inner, callback) || isGuardedWarn(inner, callback)) return;
        const line = inner.loc.start.line;
        ctx.violated(line, inner.loc.start.column + 1, lines[line - 1]?.trim() ?? "");
      });
    });
    return ctx.checked();
  },
} satisfies Rule;
