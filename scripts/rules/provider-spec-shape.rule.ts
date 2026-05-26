/**
 * Rule: provider-spec-shape
 *
 * Flag test assertions that enumerate the provider registry (getAllProviders /
 * getAllShims) by count or exhaustive name list instead of asserting each
 * provider's capability shape.
 *
 * A registry-enumeration test (toHaveLength(N) or toEqual([...names...])) is a
 * mechanical bump magnet: adding a new provider requires only updating a number
 * or list with zero validation of the new provider's name, serverName,
 * toolPrefix, or native.* fields.
 *
 * The fix is to add a per-provider test that asserts the fields that matter,
 * then delete the enumeration assertion. The individual provider shape tests
 * already prove membership implicitly (getProvider would return undefined if
 * the provider wasn't registered, and requireProvider guards on that).
 *
 * Detection strategy: within a single test/it callback, if getAllProviders() or
 * getAllShims() is called AND a toHaveLength or toEqual(array) assertion is
 * present, flag the assertion. The intermediate-variable pattern
 * (const names = getAllProviders().map(...); expect(names).toEqual([...]))
 * is covered by scope-level detection.
 *
 * Sources: #2420, flagged in #2391 adversarial review.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function isRegistryIdentifier(node: ts.Node): boolean {
  return ts.isIdentifier(node) && (node.text === "getAllProviders" || node.text === "getAllShims");
}

function containsRegistryCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && isRegistryIdentifier(node.expression)) return true;
  return ts.forEachChild(node, containsRegistryCall) ?? false;
}

function isStringOrNumberLiteral(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

function isEnumerationAssertion(methodName: string, args: ts.NodeArray<ts.Expression>): boolean {
  // toHaveLength(N) where N > 0 — a non-zero count is a mechanical bump target.
  // N = 0 (emptiness check) is legitimate (e.g. after _resetRegistries).
  if (methodName === "toHaveLength" && args.length === 1) {
    const arg = args[0];
    return arg !== undefined && ts.isNumericLiteral(arg) && Number(arg.text) > 0;
  }
  // toEqual([s1, s2, ...]) where every element is a string/number literal —
  // this is a name/count list, not a shape assertion.
  // toEqual([]) and toEqual([objRef]) are legitimate and must not be flagged.
  if (methodName === "toEqual" && args.length === 1) {
    const arg = args[0];
    if (!arg || !ts.isArrayLiteralExpression(arg)) return false;
    if (arg.elements.length === 0) return false; // empty check is fine
    return arg.elements.every(isStringOrNumberLiteral);
  }
  return false;
}

function isTestCallback(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return name === "test" || name === "it";
}

function findTestCallbackBody(node: ts.Node): ts.Node | undefined {
  if (isTestCallback(node)) {
    const call = node as ts.CallExpression;
    // test("name", () => { ... }) — callback is the last argument
    const last = call.arguments[call.arguments.length - 1];
    if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) && ts.isBlock(last.body)) {
      return last.body;
    }
  }
  return undefined;
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

const rule: CheckRule = {
  id: "provider-spec-shape",
  kind: "check",
  scold:
    "getAllProviders/getAllShims enumeration assertion — assert each provider's capability shape instead of registry count or name list",
  guidance: [
    "a count or exhaustive name list forces a mechanical bump on every new provider with zero validation of its shape — adding a provider should require a new test that asserts name, serverName, toolPrefix, and relevant native.* fields, not a number change",
    "delete the enumeration assertion; the per-provider shape tests prove membership implicitly (requireProvider/getProvider fails the test if the provider is absent)",
    "example: expect(getProvider('newprovider').native.costTracking).toBe(false) is load-bearing; expect(getAllProviders().length).toBe(9) is not",
  ],
  documentation: "#2420",
  appliesToTests: true,
  check({ file, ast, violated }) {
    const lines = file.content.split("\n");
    const sf = ast.sourceFile;

    // Find every test/it call, walk its body for enumeration assertions that
    // co-occur with a registry call anywhere in the same test scope.
    const allCalls = collectAll(sf, ts.isCallExpression);

    for (const call of allCalls) {
      const body = findTestCallbackBody(call);
      if (!body) continue;

      // Does this test call getAllProviders() or getAllShims()?
      if (!containsRegistryCall(body)) continue;

      // Find any enumeration assertions within this test body
      const assertCalls = collectAll(body, ts.isCallExpression);
      for (const assertCall of assertCalls) {
        if (!ts.isPropertyAccessExpression(assertCall.expression)) continue;
        const methodName = assertCall.expression.name.text;
        if (!isEnumerationAssertion(methodName, assertCall.arguments)) continue;

        const pos = ast.positionOf(assertCall);
        violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
      }
    }
  },
};

export default rule;
