import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Flag tests that check a discriminated-union sub-field inside an `if (x.disc === lit)` guard
 * without first asserting the discriminant. `if (result.kind === "ok") { expect(result.value)... }`
 * asserts nothing when the guard is false: a regression that returns the wrong variant silently
 * skips the block and the test passes vacuously. Make the discriminant itself an assertion,
 * `expect(result.kind).toBe("ok")`, outside the guard (an assertion inside the guard is skipped
 * along with everything else in it, so it does not count). Sources: #1990 (x3), #2049.
 *
 * Flagged: an `if` (with or without `else`) whose condition is `member === literal` (string,
 * number, `true` or `false`, either order) and whose consequent holds an `expect(obj.field)` on the
 * same object, when the enclosing function has no `expect(obj.disc)` with `toBe`, `toEqual` or
 * `toStrictEqual` of that same literal outside the guard. Deliberately not caught: guards on a bare
 * identifier or a call result, `&&` conditions, `==`, and `switch` narrowing.
 */
const isFunction = (node: TSESTree.Node): boolean =>
  node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";

const isExpectCall = (node: TSESTree.Node): node is TSESTree.CallExpression =>
  node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect";

const isPropertyAccess = (node: TSESTree.Node): node is TSESTree.MemberExpression =>
  node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier";

const isLiteral = (node: TSESTree.Node): node is TSESTree.Literal =>
  node.type === "Literal" &&
  (typeof node.value === "string" || typeof node.value === "number" || typeof node.value === "boolean");

const literalText = (node: TSESTree.Node): string => (node.type === "Literal" ? String(node.value) : "");

const propName = (member: TSESTree.MemberExpression): string =>
  member.property.type === "Identifier" ? member.property.name : "";

export default {
  id: "test-unguarded-narrowing",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold:
    "expect() inside if-guard without asserting the discriminant — test passes vacuously if the wrong variant is returned",
  guidance: [
    'assert the discriminant first: expect(result.kind).toBe("expected") before narrowing',
    'or remove the if-guard and assert directly: expect(result).toEqual({ kind: "expected", ... })',
    'TypeScript still needs the guard to narrow: keep it, or use `if (result.kind !== "ok") throw new Error(...)`',
  ],
  documentation: "#2247",
  check(ctx) {
    const code = ctx.file.content;
    const lines = code.split("\n");
    const text = (node: TSESTree.Node): string => code.slice(node.range[0], node.range[1]);
    walk(ctx.ast().program, (guard) => {
      if (guard.type !== "IfStatement") return;
      const cond = guard.test;
      if (cond.type !== "BinaryExpression" || cond.operator !== "===") return;
      let member: TSESTree.MemberExpression | undefined;
      let lit: TSESTree.Node | undefined;
      if (isPropertyAccess(cond.left) && isLiteral(cond.right)) [member, lit] = [cond.left, cond.right];
      else if (isPropertyAccess(cond.right) && isLiteral(cond.left)) [member, lit] = [cond.right, cond.left];
      if (member === undefined || lit === undefined) return;

      const objText = text(member.object);
      const discProp = propName(member);
      const litVal = literalText(lit);

      let hasSubFieldExpect = false;
      walk(guard.consequent, (inner) => {
        if (!isExpectCall(inner)) return;
        const arg = inner.arguments[0];
        if (arg && isPropertyAccess(arg) && text(arg.object) === objText) hasSubFieldExpect = true;
      });
      if (!hasSubFieldExpect) return;

      let fn: TSESTree.Node | undefined = guard.parent;
      while (fn !== undefined && !isFunction(fn)) fn = fn.parent;
      if (fn === undefined) return;

      let hasDiscAssertOutsideGuard = false;
      walk(fn, (call) => {
        if (call.type !== "CallExpression" || call.callee.type !== "MemberExpression") return;
        if (call.range[0] >= guard.range[0] && call.range[1] <= guard.range[1]) return;
        const method = propName(call.callee);
        if (method !== "toBe" && method !== "toEqual" && method !== "toStrictEqual") return;
        const receiver = call.callee.object;
        if (!isExpectCall(receiver)) return;
        const arg = receiver.arguments[0];
        if (!arg || !isPropertyAccess(arg) || text(arg.object) !== objText || propName(arg) !== discProp) return;
        const assertArg = call.arguments[0];
        if (assertArg && literalText(assertArg) === litVal) hasDiscAssertOutsideGuard = true;
      });
      if (hasDiscAssertOutsideGuard) return;

      const { line, column } = guard.loc.start;
      ctx.violated(line, column + 1, `if (${text(cond)}) { expect(${objText}.…)… }`);
    });
    return ctx.checked();
  },
} satisfies Rule;
