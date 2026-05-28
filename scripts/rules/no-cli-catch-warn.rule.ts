/**
 * Rule: no-cli-catch-warn
 *
 * `packages/command/` is the CLI binary. Unlike the daemon, it does not run
 * under `installDaemonLogCapture()`, so a `console.warn` inside a `.catch()`
 * handler writes directly to the user's terminal stderr — even for
 * unactionable bookkeeping failures that the user can do nothing about.
 * The daemon-side ring buffer absorbs warnings gracefully; the CLI does not.
 *
 * Fix: for user-facing errors, use `console.error`. For fire-and-forget IPC
 * bookkeeping, swallow silently or gate the warn behind `process.env.DEBUG`
 * or a `--verbose` flag.
 *
 * The rule cannot detect `.catch(namedHandler)` reference forms — only
 * inline arrow functions and function expressions are checked.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function hasVerbosityGuard(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = node.getText(sourceFile);
  return text.includes("process.env.DEBUG") || text.includes("verbose");
}

function findConsoleWarns(root: ts.Node, warns: ts.CallExpression[]): void {
  ts.forEachChild(root, function visit(node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "console" &&
        expr.name.text === "warn"
      ) {
        warns.push(node);
        return;
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
    "console.warn inside .catch() in packages/command/ — writes to terminal stderr even for unactionable bookkeeping failures",
  guidance: [
    "for user-facing errors, use console.error instead of console.warn",
    "for fire-and-forget IPC calls, swallow silently in the catch handler",
    "if the warn is intentional, gate it behind process.env.DEBUG or a --verbose flag check",
    "the daemon ring buffer absorbs console.warn; the CLI binary writes it directly to the user's terminal",
  ],
  documentation: "#2474",
  check({ file, violated, checked, ast }) {
    if (!file.relPath.startsWith("packages/command/")) return;

    const catchCalls = ast.callsTo("catch");
    for (const call of catchCalls) {
      const [callback] = call.arguments;
      if (!callback) continue;
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;

      checked();

      if (hasVerbosityGuard(callback, ast.sourceFile)) continue;

      const warns: ts.CallExpression[] = [];
      findConsoleWarns(callback, warns);

      for (const warn of warns) {
        const { line, column } = ast.positionOf(warn);
        const snippet = file.content.split("\n")[line - 1]?.trim() ?? "";
        violated(line, column, snippet);
      }
    }
  },
};

export default rule;
