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

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

/** An arrow function with no parameters whose body is `{}` or `undefined`. */
function isEmptyThunk(node: TSESTree.Node): node is TSESTree.ArrowFunctionExpression {
  if (node.type !== "ArrowFunctionExpression" || node.params.length !== 0) return false;
  const body = node.body;
  if (body.type === "BlockStatement") return body.body.length === 0;
  return body.type === "Identifier" && body.name === "undefined";
}

/**
 * `new Promise(() => {})` or `new Promise(() => undefined)` — i.e. a promise that never resolves.
 */
function isNeverResolvingPromise(init: TSESTree.Node): boolean {
  if (init.type !== "NewExpression") return false;
  if (init.callee.type !== "Identifier" || init.callee.name !== "Promise") return false;
  const [arg] = init.arguments;
  return init.arguments.length === 1 && arg !== undefined && isEmptyThunk(arg);
}

/** `() => {}` or `() => undefined` — a no-op arrow function. */
const isNoopArrow = isEmptyThunk;

export default {
  id: "spawn-mock-kill-resolves-exited",
  type: "check",
  category: "testing",
  ast: true,
  scold: "spawn mock: exited is a never-resolving promise and kill() is a no-op — test teardown will hang",
  guidance: [
    "wire kill() to settle exited: const { promise: exited, resolve } = Promise.withResolvers(); kill = () => resolve(0)",
    "or add a shared makeFakeProc() helper under test/ that returns { exited, kill } where kill() resolves exited",
    "the no-op kill + never-settling exited blocks server.stop() in afterEach for the full SIGTERM→SIGKILL window (~5–7 s)",
  ],
  documentation: "#2249",
  tests: "only",
  check(ctx) {
    const lines = ctx.file.content.split("\n");

    walk(ctx.ast().program, (obj) => {
      if (obj.type !== "ObjectExpression") return;
      let exitedProp: TSESTree.Property | undefined;
      let hasNoopKill = false;

      for (const prop of obj.properties) {
        if (prop.type !== "Property" || prop.computed || prop.method || prop.kind !== "init") continue;
        if (prop.key.type !== "Identifier") continue;
        if (prop.key.name === "exited" && isNeverResolvingPromise(prop.value)) exitedProp = prop;
        else if (prop.key.name === "kill" && isNoopArrow(prop.value)) hasNoopKill = true;
      }

      if (exitedProp && hasNoopKill) {
        const { line, column } = exitedProp.loc.start;
        ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
