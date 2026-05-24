/**
 * Rule: spawn-mock-kill-resolves-exited
 *
 * Test spawn mocks that pair `exited: new Promise(() => {})` (a promise that
 * never resolves) with `kill: () => {}` (a no-op) cause test teardown to hang.
 *
 * When the code under test tears down (e.g. `server.stop()` in afterEach), it
 * calls `kill()` then `await`s `proc.exited`. Because `kill()` never settles
 * `exited`, teardown blocks for the full SIGTERM→SIGKILL escalation window
 * (~5–7 s) or until the Bun hook timeout — every test in the suite pays it.
 *
 * Uses the TypeScript AST so that only object literals containing BOTH
 * properties are flagged — two separate objects within proximity don't
 * false-positive (see #2284).
 */

import ts from "typescript";

import type { CheckRule } from "./_engine/rule";

/**
 * True when a PropertyAssignment's initializer is `new Promise(() => {})` or
 * `new Promise(() => undefined)` — i.e. a promise that never resolves.
 */
function isNeverResolvingPromise(init: ts.Expression): boolean {
  if (!ts.isNewExpression(init)) return false;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== "Promise") return false;
  const args = init.arguments;
  if (!args || args.length !== 1) return false;
  const arg = args[0];
  if (!ts.isArrowFunction(arg)) return false;
  if (arg.parameters.length !== 0) return false;
  const body = arg.body;
  if (ts.isBlock(body)) {
    return body.statements.length === 0;
  }
  // () => undefined
  return ts.isIdentifier(body) && body.text === "undefined";
}

/**
 * True when a PropertyAssignment's initializer is `() => {}` or
 * `() => undefined` — i.e. a no-op arrow function.
 */
function isNoopArrow(init: ts.Expression): boolean {
  if (!ts.isArrowFunction(init)) return false;
  if (init.parameters.length !== 0) return false;
  const body = init.body;
  if (ts.isBlock(body)) {
    return body.statements.length === 0;
  }
  return ts.isIdentifier(body) && body.text === "undefined";
}

const rule: CheckRule = {
  id: "spawn-mock-kill-resolves-exited",
  kind: "check",
  scold: "spawn mock: exited is a never-resolving promise and kill() is a no-op — test teardown will hang",
  guidance: [
    "wire kill() to settle exited: const { promise: exited, resolve } = Promise.withResolvers(); kill = () => resolve(0)",
    "or add a shared makeFakeProc() helper under test/ that returns { exited, kill } where kill() resolves exited",
    "the no-op kill + never-settling exited blocks server.stop() in afterEach for the full SIGTERM→SIGKILL window (~5–7 s)",
  ],
  documentation: "#2249",
  appliesToTests: true,
  check({ file, ast, violated }) {
    const { sourceFile } = ast;
    const lines = sourceFile.text.split("\n");

    for (const obj of ast.find(ts.isObjectLiteralExpression)) {
      let exitedProp: ts.PropertyAssignment | undefined;
      let hasNoopKill = false;

      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = prop.name;
        if (!ts.isIdentifier(name)) continue;

        if (name.text === "exited" && isNeverResolvingPromise(prop.initializer)) {
          exitedProp = prop;
        } else if (name.text === "kill" && isNoopArrow(prop.initializer)) {
          hasNoopKill = true;
        }
      }

      if (exitedProp && hasNoopKill) {
        const { line, column } = ast.positionOf(exitedProp);
        violated(line, column, (lines[line - 1] ?? "").trim());
      }
    }
  },
};

export default rule;
