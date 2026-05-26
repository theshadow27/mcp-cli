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
 * Detection strategy:
 *   Within a test/it/test.skip/test.only/test.each callback body, if
 *   getAllProviders() or getAllShims() is called AND the subject of an
 *   expect() assertion is syntactically traceable to that registry call
 *   (direct call, collection-preserving chain, or a variable assigned from
 *   one), flag enumeration assertions:
 *     - toHaveLength(N>0) or toEqual([...string/number literals...])
 *       when the subject is the collection itself
 *     - toBe(N>0) or toEqual(N>0) when the subject is the collection's .length
 *
 *   The intermediate-variable pattern is handled via collectCollectionVars.
 *   Collection-consuming operations (.find, .reduce, index access) are NOT
 *   tracked — shape assertions on individual elements are legitimate.
 *
 * Known limitations:
 *   - test.each with a concise arrow body (no curly braces) is not inspected
 *   - describe-scope registry calls are not tracked across nested test bodies
 *   - helper function indirection (const counts = () => getAllProviders().length)
 *     is not detected — it is a syntactic guard, not a semantic one
 *
 * Sources: #2420, flagged in #2391 adversarial review.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

function isRegistryIdentifier(node: ts.Node): boolean {
  return ts.isIdentifier(node) && (node.text === "getAllProviders" || node.text === "getAllShims");
}

// Quick scan (shallow — stops at nested function bodies): does this test body
// contain a direct getAllProviders/getAllShims call?
function containsRegistryCallShallow(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && isRegistryIdentifier(node.expression)) return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return false;
  return ts.forEachChild(node, containsRegistryCallShallow) ?? false;
}

function isStringOrNumberLiteral(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

// Methods that preserve collection identity (result is still a collection of registry items).
// Excludes .find, .reduce, .at, [N] — those produce single elements or scalars.
const COLLECTION_METHODS = new Set(["map", "filter", "sort", "slice", "concat", "flatMap", "reverse"]);

// Is `node` the registry collection (or a collection-preserving chain thereof)?
// Does NOT include single-element results (.find, index access, etc.).
function isRegistryCollection(node: ts.Node, collectionVars: Set<string>): boolean {
  if (ts.isCallExpression(node)) {
    if (isRegistryIdentifier(node.expression)) return true;
    if (ts.isPropertyAccessExpression(node.expression) && COLLECTION_METHODS.has(node.expression.name.text)) {
      return isRegistryCollection(node.expression.expression, collectionVars);
    }
  }
  if (ts.isParenthesizedExpression(node)) return isRegistryCollection(node.expression, collectionVars);
  return ts.isIdentifier(node) && collectionVars.has(node.text);
}

// Is `node` the .length of a registry collection?
function isRegistryLength(node: ts.Node, collectionVars: Set<string>): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "length" &&
    isRegistryCollection(node.expression, collectionVars)
  );
}

// Walk body without descending into nested function bodies.
function walkShallow(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child)) return;
    walkShallow(child, visit);
  });
}

// Collect variables in the test body that are assigned from a registry collection.
// Two passes handle one-hop derivation: const a = getAllProviders(); const b = a.map(...).
function collectCollectionVars(body: ts.Node): Set<string> {
  const vars = new Set<string>();
  for (let pass = 0; pass < 2; pass++) {
    walkShallow(body, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        !vars.has(node.name.text) &&
        isRegistryCollection(node.initializer, vars)
      ) {
        vars.add(node.name.text);
      }
    });
  }
  return vars;
}

// Resolve the subject of an expect() call, walking through .not/.resolves/.rejects.
function findExpectSubject(node: ts.Node): ts.Expression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") {
    return node.arguments[0];
  }
  if (ts.isPropertyAccessExpression(node)) return findExpectSubject(node.expression);
  return undefined;
}

// Is this an enumeration assertion on a registry collection?
// Flags toHaveLength(N>0) and toEqual([...string/number literals...] with 1+ elements).
function isCollectionEnumerationAssertion(methodName: string, args: ts.NodeArray<ts.Expression>): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  if (!arg) return false;
  if (methodName === "toHaveLength") return ts.isNumericLiteral(arg) && Number(arg.text) > 0;
  if (methodName === "toEqual" && ts.isArrayLiteralExpression(arg)) {
    if (arg.elements.length === 0) return false; // empty check is legitimate
    return arg.elements.every(isStringOrNumberLiteral);
  }
  return false;
}

// Is this an enumeration assertion on a registry .length value?
// Flags toBe(N>0) and toEqual(N>0).
function isLengthEnumerationAssertion(methodName: string, args: ts.NodeArray<ts.Expression>): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  if (!arg) return false;
  return (methodName === "toBe" || methodName === "toEqual") && ts.isNumericLiteral(arg) && Number(arg.text) > 0;
}

// Matches test/it and their modifier forms: test.skip, test.only, it.skip, it.only,
// test.each(table)(...), it.each(table)(...).
function isTestCallback(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  // bare test(...) / it(...)
  if (ts.isIdentifier(callee)) return callee.text === "test" || callee.text === "it";
  // test.skip(...) / test.only(...) / it.skip(...) / it.only(...) etc.
  if (ts.isPropertyAccessExpression(callee)) {
    const root = callee.expression;
    return ts.isIdentifier(root) && (root.text === "test" || root.text === "it");
  }
  // test.each(table)(name, fn) — outer callee is itself a call expression
  if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
    const root = callee.expression.expression;
    return ts.isIdentifier(root) && (root.text === "test" || root.text === "it");
  }
  return false;
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
    "only the collection itself (and collection-preserving chains: .map/.filter/.sort/etc.) is tracked — shape assertions on individual elements obtained via .find, .reduce, or index access are not flagged",
  ],
  documentation: "#2420",
  appliesToTests: true,
  check({ file, ast, violated, checked }) {
    const lines = file.content.split("\n");
    const sf = ast.sourceFile;

    const allCalls = collectAll(sf, ts.isCallExpression);
    checked(); // signal that we performed real AST inspection on this file

    for (const call of allCalls) {
      const body = findTestCallbackBody(call);
      if (!body) continue;

      // Quick filter: does this test body reference getAllProviders/getAllShims at all?
      if (!containsRegistryCallShallow(body)) continue;

      // Collect variables in this scope that hold the registry collection (or a
      // collection-preserving transformation of it).
      const collectionVars = collectCollectionVars(body);

      // Scan for expect(...).method(...) calls whose subject traces to the registry.
      const assertCalls = collectAll(body, ts.isCallExpression);
      for (const assertCall of assertCalls) {
        if (!ts.isPropertyAccessExpression(assertCall.expression)) continue;
        const methodName = assertCall.expression.name.text;

        const subject = findExpectSubject(assertCall.expression.expression);
        if (!subject) continue;

        let isViolation = false;
        if (isRegistryCollection(subject, collectionVars)) {
          isViolation = isCollectionEnumerationAssertion(methodName, assertCall.arguments);
        } else if (isRegistryLength(subject, collectionVars)) {
          isViolation = isLengthEnumerationAssertion(methodName, assertCall.arguments);
        }
        if (!isViolation) continue;

        const pos = ast.positionOf(assertCall);
        violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
      }
    }
  },
};

export default rule;
