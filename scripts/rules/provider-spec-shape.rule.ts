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
 *   - describe-scope registry calls are not tracked across nested test bodies
 *   - helper function indirection (const counts = () => getAllProviders().length)
 *     is not detected — it is a syntactic guard, not a semantic one
 *
 * Sources: #2420, flagged in #2391 adversarial review.
 */

import { type Rule, type TSESTree, walk } from "am-i-done";

type Node = TSESTree.Node;

const isFunctionNode = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration";

/** The direct child nodes of `node`, in key order. */
function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range" || typeof value !== "object" || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string")
        out.push(v as Node);
    }
  }
  return out;
}

function isRegistryIdentifier(node: Node): boolean {
  return node.type === "Identifier" && (node.name === "getAllProviders" || node.name === "getAllShims");
}

// Quick scan (shallow: stops at nested function bodies): does this test body
// contain a direct getAllProviders/getAllShims call?
function containsRegistryCallShallow(node: Node): boolean {
  if (node.type === "CallExpression" && isRegistryIdentifier(node.callee)) return true;
  if (isFunctionNode(node)) return false;
  return childNodes(node).some(containsRegistryCallShallow);
}

const isStringOrNumberLiteral = (node: Node | null): boolean =>
  node?.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number");

// Methods that preserve collection identity (result is still a collection of registry items).
// Excludes .find, .reduce, .at, [N]: those produce single elements or scalars.
const COLLECTION_METHODS = new Set(["map", "filter", "sort", "slice", "concat", "flatMap", "reverse"]);

// Is `node` the registry collection (or a collection-preserving chain thereof)?
// Does NOT include single-element results (.find, index access, etc.).
function isRegistryCollection(node: Node, collectionVars: Set<string>): boolean {
  if (node.type === "CallExpression") {
    if (isRegistryIdentifier(node.callee)) return true;
    const callee = node.callee;
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      COLLECTION_METHODS.has(callee.property.name)
    ) {
      return isRegistryCollection(callee.object, collectionVars);
    }
  }
  return node.type === "Identifier" && collectionVars.has(node.name);
}

// Is `node` the .length of a registry collection?
function isRegistryLength(node: Node, collectionVars: Set<string>): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "length" &&
    isRegistryCollection(node.object, collectionVars)
  );
}

// Walk body without descending into nested function bodies.
function walkShallow(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of childNodes(node)) {
    if (isFunctionNode(child)) continue;
    walkShallow(child, visit);
  }
}

// Collect variables in the test body that are assigned from a registry collection.
// Two passes handle one-hop derivation: const a = getAllProviders(); const b = a.map(...).
function collectCollectionVars(body: Node): Set<string> {
  const vars = new Set<string>();
  for (let pass = 0; pass < 2; pass++) {
    walkShallow(body, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.init &&
        node.id.type === "Identifier" &&
        !vars.has(node.id.name) &&
        isRegistryCollection(node.init, vars)
      ) {
        vars.add(node.id.name);
      }
    });
  }
  return vars;
}

// Resolve the subject of an expect() call, walking through .not/.resolves/.rejects.
function findExpectSubject(node: Node): Node | undefined {
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect") {
    return node.arguments[0];
  }
  if (node.type === "MemberExpression" && !node.computed) return findExpectSubject(node.object);
  return undefined;
}

// Is this an enumeration assertion on a registry collection?
// Flags toHaveLength(N>0) and toEqual([...string/number literals...] with 1+ elements).
function isCollectionEnumerationAssertion(methodName: string, args: TSESTree.CallExpressionArgument[]): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  if (!arg) return false;
  if (methodName === "toHaveLength") return arg.type === "Literal" && typeof arg.value === "number" && arg.value > 0;
  if (methodName === "toEqual" && arg.type === "ArrayExpression") {
    if (arg.elements.length === 0) return false; // empty check is legitimate
    return arg.elements.every(isStringOrNumberLiteral);
  }
  return false;
}

// Is this an enumeration assertion on a registry .length value?
// Flags toBe(N>0) and toEqual(N>0).
function isLengthEnumerationAssertion(methodName: string, args: TSESTree.CallExpressionArgument[]): boolean {
  if (args.length !== 1) return false;
  const arg = args[0];
  if (!arg) return false;
  return (
    (methodName === "toBe" || methodName === "toEqual") &&
    arg.type === "Literal" &&
    typeof arg.value === "number" &&
    arg.value > 0
  );
}

const isTestName = (node: Node): boolean => node.type === "Identifier" && (node.name === "test" || node.name === "it");

// Matches test/it and their modifier forms: test.skip, test.only, it.skip, it.only,
// test.each(table)(...), it.each(table)(...).
function isTestCallback(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  // bare test(...) / it(...)
  if (callee.type === "Identifier") return isTestName(callee);
  // test.skip(...) / test.only(...) / it.skip(...) / it.only(...) etc.
  if (callee.type === "MemberExpression") return isTestName(callee.object);
  // test.each(table)(name, fn): the outer callee is itself a call expression
  if (callee.type === "CallExpression" && callee.callee.type === "MemberExpression") {
    return isTestName(callee.callee.object);
  }
  return false;
}

function findTestCallbackBody(node: TSESTree.CallExpression): Node | undefined {
  if (!isTestCallback(node)) return undefined;
  const last = node.arguments[node.arguments.length - 1];
  if (last && (last.type === "ArrowFunctionExpression" || last.type === "FunctionExpression")) return last.body;
  return undefined;
}

function collectCalls(root: Node): TSESTree.CallExpression[] {
  const results: TSESTree.CallExpression[] = [];
  walk(root, (n) => {
    if (n.type === "CallExpression") results.push(n);
  });
  return results;
}

export default {
  id: "provider-spec-shape",
  type: "check",
  category: "testing",
  ast: true,
  scold:
    "getAllProviders/getAllShims enumeration assertion: assert each provider's capability shape instead of registry count or name list",
  guidance: [
    "a count or exhaustive name list forces a mechanical bump on every new provider with zero validation of its shape: adding a provider should require a new test that asserts name, serverName, toolPrefix, and relevant native.* fields, not a number change",
    "delete the enumeration assertion; the per-provider shape tests prove membership implicitly (requireProvider/getProvider fails the test if the provider is absent)",
    "example: expect(getProvider('newprovider').native.costTracking).toBe(false) is load-bearing; expect(getAllProviders().length).toBe(9) is not",
    "only the collection itself (and collection-preserving chains: .map/.filter/.sort/etc.) is tracked: shape assertions on individual elements obtained via .find, .reduce, or index access are not flagged",
  ],
  documentation: "#2420",
  tests: "only",
  check(ctx) {
    const lines = ctx.file.content.split("\n");

    for (const call of collectCalls(ctx.ast().program)) {
      const body = findTestCallbackBody(call);
      if (!body) continue;

      // Quick filter: does this test body reference getAllProviders/getAllShims at all?
      if (!containsRegistryCallShallow(body)) continue;

      // Collect variables in this scope that hold the registry collection (or a
      // collection-preserving transformation of it).
      const collectionVars = collectCollectionVars(body);

      // Scan for expect(...).method(...) calls whose subject traces to the registry.
      for (const assertCall of collectCalls(body)) {
        const callee = assertCall.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") continue;
        const methodName = callee.property.name;

        const subject = findExpectSubject(callee.object);
        if (!subject) continue;

        let isViolation = false;
        if (isRegistryCollection(subject, collectionVars)) {
          isViolation = isCollectionEnumerationAssertion(methodName, assertCall.arguments);
        } else if (isRegistryLength(subject, collectionVars)) {
          isViolation = isLengthEnumerationAssertion(methodName, assertCall.arguments);
        }
        if (!isViolation) continue;

        const { line, column } = assertCall.loc.start;
        ctx.violated(line, column + 1, lines[line - 1]?.trim() ?? "");
      }
    }
    return ctx.checked();
  },
} satisfies Rule;
