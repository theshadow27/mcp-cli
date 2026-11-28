/**
 * Rule: check-tool-result-iserror
 *
 * Flag `callTool()` results whose `.content` is accessed without a
 * preceding `isError` check and without going through `unwrapToolResult`
 * or `unwrapToolResultJson`. This catches the "silent data loss" bug
 * where an error response is parsed as valid data.
 *
 * Detection strategy (AST):
 *   1. Find all `callTool(...)` call expressions.
 *   2. Walk up through expression wrappers (await, as, parens, !)
 *      to the enclosing VariableDeclaration to get the result binding.
 *   3. Scan the enclosing block for `.content` property accesses on
 *      that binding (excluding nested function bodies).
 *   4. For each `.content` access, require a *preceding* `isError`
 *      property access (by source position) or an `unwrapToolResult`
 *      call. "Same scope but after" does not count as a guard.
 *   5. Report the first unguarded `.content` access as a violation.
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

type Node = TSESTree.Node;
type Member = TSESTree.MemberExpression;

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]);

function getEnclosingBlock(node: Node): Node {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "BlockStatement" || parent.type === "Program" || FUNCTIONS.has(parent.type)) return parent;
    parent = parent.parent;
  }
  return node;
}

/** Visit `root` and everything under it except nested function bodies. */
function walkSkippingNestedFunctions(root: Node, visit: (n: Node) => void): void {
  let skipUntil = 0;
  walk(root, (node) => {
    if (node.range[0] < skipUntil) return;
    if (node !== root && FUNCTIONS.has(node.type)) {
      skipUntil = node.range[1];
      return;
    }
    visit(node);
  });
}

/** Wrappers that pass the value through: `await x`, `x as T`, `x!`, `<T>x`, `x satisfies T`, `a?.b()`. */
function isExpressionWrapper(node: Node): boolean {
  return (
    node.type === "AwaitExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  );
}

/** `obj.<name>` (not `obj[name]`), whatever `obj` is. */
function isNamedAccess(node: Node, name: string): node is Member {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === name
  );
}

/** `<binding>.<name>`. */
function isAccessOn(node: Node, binding: string, name: string): boolean {
  return isNamedAccess(node, name) && node.object.type === "Identifier" && node.object.name === binding;
}

function getBindingName(node: Node): string | undefined {
  let current = node.parent;
  while (current) {
    if (current.type === "VariableDeclarator" && current.id.type === "Identifier") return current.id.name;
    if (isExpressionWrapper(current)) {
      current = current.parent;
      continue;
    }
    break;
  }
  return undefined;
}

function getDestructuredContentElement(node: Node): Node | undefined {
  let current = node.parent;
  while (current) {
    if (current.type === "VariableDeclarator" && current.id.type === "ObjectPattern") {
      return current.id.properties.find(
        (el) => el.type === "Property" && !el.computed && el.key.type === "Identifier" && el.key.name === "content",
      );
    }
    if (isExpressionWrapper(current)) {
      current = current.parent;
      continue;
    }
    break;
  }
  return undefined;
}

function getInlineContentAccess(node: Node): Member | undefined {
  let current: Node = node;
  while (current.parent) {
    const parent: Node = current.parent;
    if (isExpressionWrapper(parent)) {
      current = parent;
      continue;
    }
    if (isNamedAccess(parent, "content") && parent.object === current) return parent;
    break;
  }
  return undefined;
}

function hasUnwrapCallBefore(scope: Node, bindingName: string, beforePos: number): boolean {
  let found = false;
  walkSkippingNestedFunctions(scope, (n) => {
    if (found || n.type !== "CallExpression" || n.range[0] >= beforePos) return;
    const callee = n.callee;
    const name =
      callee.type === "Identifier"
        ? callee.name
        : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
          ? callee.property.name
          : undefined;
    if (name !== "unwrapToolResult" && name !== "unwrapToolResultJson") return;
    if (n.arguments.some((arg) => arg.type === "Identifier" && arg.name === bindingName)) found = true;
  });
  return found;
}

function hasIsErrorCheckBefore(scope: Node, bindingName: string, beforePos: number): boolean {
  let found = false;
  walkSkippingNestedFunctions(scope, (n) => {
    if (found || n.range[0] >= beforePos) return;
    if (isAccessOn(n, bindingName, "isError")) found = true;
  });
  return found;
}

function findContentAccesses(scope: Node, bindingName: string): Member[] {
  const accesses: Member[] = [];
  walkSkippingNestedFunctions(scope, (n) => {
    if (isAccessOn(n, bindingName, "content")) accesses.push(n as Member);
  });
  return accesses;
}

/** `callTool(...)`, `x.callTool(...)` and `x["callTool"](...)`. */
function isCallTool(node: Node): node is TSESTree.CallExpression {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === "callTool";
  if (callee.type !== "MemberExpression") return false;
  if (!callee.computed) return callee.property.type === "Identifier" && callee.property.name === "callTool";
  return callee.property.type === "Literal" && callee.property.value === "callTool";
}

export default {
  id: "check-tool-result-iserror",
  type: "check",
  category: "architecture",
  ast: true,
  scold:
    "callTool() result .content accessed without checking isError — error responses will be silently parsed as data",
  guidance: [
    "use unwrapToolResult(result) or unwrapToolResultJson<T>(result) from @mcp-cli/core",
    "alternatively, check result.isError before accessing result.content",
    "see packages/core/src/mcp-result.ts for the shared helper",
  ],
  documentation: "#2271",
  tests: "exclude",
  check(ctx) {
    if (!ctx.file.content.includes("callTool")) return ctx.skipped();
    const lines = ctx.file.content.split("\n");
    const report = (node: Node) => {
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    };

    const calls: TSESTree.CallExpression[] = [];
    walk(ctx.ast().program, (node) => {
      if (isCallTool(node)) calls.push(node);
    });

    for (const call of calls) {
      const bindingName = getBindingName(call);
      if (!bindingName) {
        const destructuredEl = getDestructuredContentElement(call);
        if (destructuredEl) {
          report(destructuredEl);
          continue;
        }
        const inlineAccess = getInlineContentAccess(call);
        if (inlineAccess) report(inlineAccess);
        continue;
      }

      const scope = getEnclosingBlock(call);
      for (const access of findContentAccesses(scope, bindingName)) {
        const accessPos = access.range[0];
        if (hasUnwrapCallBefore(scope, bindingName, accessPos)) continue;
        if (hasIsErrorCheckBefore(scope, bindingName, accessPos)) continue;
        report(access);
        break;
      }
    }
    return ctx.checked();
  },
} satisfies Rule;
