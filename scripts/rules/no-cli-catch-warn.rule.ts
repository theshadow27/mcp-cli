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

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

/** Build a child→parent map for every descendant of `root`. */
function buildParentMap(root: ts.Node): Map<ts.Node, ts.Node> {
  const map = new Map<ts.Node, ts.Node>();
  function walk(node: ts.Node): void {
    ts.forEachChild(node, (child) => {
      map.set(child, node);
      walk(child);
    });
  }
  walk(root);
  return map;
}

/**
 * Returns true if `node` is a recognised verbosity guard:
 *   - `process.env.DEBUG` (exact property access chain)
 *   - an identifier whose text is `verbose`, `isVerbose`, or `verbosity`
 */
function isVerbosityGuardNode(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "DEBUG" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process"
  ) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return node.text === "verbose" || node.text === "isVerbose" || node.text === "verbosity";
  }
  return false;
}

/** Returns true if any node in the `condition` subtree is a verbosity guard. */
function conditionHasGuard(condition: ts.Node): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (isVerbosityGuardNode(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(condition);
  return found;
}

/**
 * Returns true if `warnNode` is directly dominated by a verbosity guard within
 * `callbackRoot`. Walks up the parent chain; stops at the callback boundary.
 *
 * A warn is guarded when it is inside the then-branch of an `if (guard) {}`
 * statement or the true-branch of a `guard ? ... : ...` expression, where the
 * condition contains a recognised verbosity guard node.
 */
function isGuardedWarn(warnNode: ts.Node, callbackRoot: ts.Node, parentMap: Map<ts.Node, ts.Node>): boolean {
  let current: ts.Node = warnNode;
  let parent: ts.Node | undefined = parentMap.get(warnNode);

  while (parent && parent !== callbackRoot) {
    if (ts.isIfStatement(parent) && current === parent.thenStatement) {
      if (conditionHasGuard(parent.expression)) return true;
    }
    if (ts.isConditionalExpression(parent) && current === parent.whenTrue) {
      if (conditionHasGuard(parent.condition)) return true;
    }
    current = parent;
    parent = parentMap.get(parent);
  }
  return false;
}

/**
 * Collects all `console.warn(...)` call expressions inside `root`, stopping
 * recursion at nested function/arrow boundaries so warns in inner closures are
 * not attributed to the outer catch callback.
 */
function findConsoleWarns(root: ts.Node, warns: ts.CallExpression[]): void {
  ts.forEachChild(root, function visit(node) {
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      return; // nested scope — not owned by this catch callback
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "console" &&
        expr.name.text === "warn"
      ) {
        warns.push(node);
        return; // don't recurse into the warn's own arguments
      }
    }
    ts.forEachChild(node, visit);
  });
}

const rule: CheckRule = {
  id: "no-cli-catch-warn",
  kind: "check",
  appliesToTests: false,
  scold:
    "console.warn inside .catch() in packages/command/src/ — writes to terminal stderr even for unactionable bookkeeping failures",
  guidance: [
    "for fire-and-forget IPC calls, swallow silently in the catch handler",
    "if the warn is intentional, gate it behind `if (process.env.DEBUG)` or `if (verbose)`",
    "for errors that are actionable by the user, use console.error instead of console.warn",
    "the daemon ring buffer absorbs console.warn; the CLI binary writes it directly to the user's terminal",
  ],
  documentation: "#2474",
  check({ file, violated, checked, ast }) {
    if (!file.relPath.startsWith("packages/command/src/")) return;

    const catchCalls = ast.callsTo("catch");
    for (const call of catchCalls) {
      const [callback] = call.arguments;
      if (!callback) continue;
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;

      checked();

      const parentMap = buildParentMap(callback);
      const warns: ts.CallExpression[] = [];
      findConsoleWarns(callback, warns);

      for (const warn of warns) {
        if (isGuardedWarn(warn, callback, parentMap)) continue;
        const { line, column } = ast.positionOf(warn);
        const snippet = file.content.split("\n")[line - 1]?.trim() ?? "";
        violated(line, column, snippet);
      }
    }
  },
};

export default rule;
