/**
 * Rule: no-raw-path-handling
 *
 * Catches two patterns of ad-hoc path handling that produce silent
 * zero-match / cross-repo bugs when symlinks or subdir invocations
 * are involved:
 *
 * 1. `s.startsWith("/")` or `s.startsWith("\\\\")` used as an
 *    absolute-path test instead of `path.isAbsolute(s)`.
 *
 * 2. (daemon only) `process.cwd()` compared with `===`/`!==` without
 *    going through `resolveRealpath`/`canonicalCwd` — symlinked CWDs
 *    silently fail the comparison.
 *
 * 3. (daemon only) `process.cwd()` passed as the *key* (first argument)
 *    to Map-like methods (`.get`, `.set`, `.has`, `.delete`) — raw CWD
 *    as a lookup key silently misses under symlinks. Only argument 0
 *    is checked; `.set(key, process.cwd())` (value position) is fine.
 *
 * 4. (daemon only) `const` variable bound to `process.cwd()` then used
 *    in `===`/`!==` comparison — same bug class as Detection 2 but one
 *    step removed. Resolution uses scope-aware name lookup, not raw
 *    identifier text matching, so parameters/locals that shadow an
 *    outer const are not falsely flagged.
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

/** The name a call is made through: `name()`, `obj.name()` or `obj["name"]()`. */
function calleeName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
  if (callee.computed && callee.property.type === "Literal" && typeof callee.property.value === "string") {
    return callee.property.value;
  }
  return undefined;
}

const SLASH = "/";
const UNC_PREFIX = "\\\\";
const MAP_METHODS = new Set(["get", "set", "has", "delete"]);

/** Match `process.cwd()` — no recursive descent. */
function isProcessCwd(node: TSESTree.Node): boolean {
  return (
    node.type === "CallExpression" &&
    node.arguments.length === 0 &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "process" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "cwd"
  );
}

type Declaration = TSESTree.VariableDeclarator | "parameter";

/**
 * Resolve an identifier to the nearest enclosing declaration (parameter or
 * const variable) using JS scope rules, then report whether it's a `const`
 * bound to `process.cwd()`. Parameters and shadowing inner locals correctly
 * short-circuit the walk — they're the binding the identifier refers to, so
 * the outer `const cwd = process.cwd()` is not consulted.
 */
function resolvesToCwdConst(id: TSESTree.Identifier): boolean {
  const decl = lookupName(id.name, id);
  if (!decl || decl === "parameter") return false;
  const list = decl.parent;
  if (list?.type !== "VariableDeclaration" || list.kind !== "const") return false;
  return !!decl.init && isProcessCwd(decl.init);
}

function paramBindsName(param: TSESTree.Node, name: string): boolean {
  if (param.type === "AssignmentPattern") return paramBindsName(param.left, name);
  return param.type === "Identifier" && param.name === name;
}

function lookupName(name: string, from: TSESTree.Node): Declaration | undefined {
  let current: TSESTree.Node = from;
  while (current.parent) {
    const parent: TSESTree.Node = current.parent;

    if (
      parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression"
    ) {
      if (parent.params.some((p) => paramBindsName(p, name))) return "parameter";
    }

    // for-loop bindings (`for (const x = ...; ...)`, `for (const x of ...)`) are
    // block-scoped to the loop including its body, so check them when ascending
    // out of the body but before the enclosing function/block scope.
    if (parent.type === "ForStatement" || parent.type === "ForInStatement" || parent.type === "ForOfStatement") {
      const init = parent.type === "ForStatement" ? parent.init : parent.left;
      if (init?.type === "VariableDeclaration") {
        for (const decl of init.declarations) {
          if (decl.id.type === "Identifier" && decl.id.name === name) return decl;
        }
      }
    }

    if (parent.type === "BlockStatement" || parent.type === "Program" || parent.type === "TSModuleBlock") {
      const found = findDeclInScope(parent.body, name);
      if (found) return found;
    }

    current = parent;
  }
  return undefined;
}

/**
 * Look up a `const`/`let`/`var` declaration of `name` in the *direct* statement
 * list of a scope. Walking all descendants would leak nested-block bindings
 * (e.g. `if (cond) { const x = ... }`) into outer scopes, violating JS lexical
 * scope and producing both false positives and false negatives.
 */
function findDeclInScope(statements: TSESTree.Node[], name: string): TSESTree.VariableDeclarator | undefined {
  for (const raw of statements) {
    const stmt = raw.type === "ExportNamedDeclaration" && raw.declaration ? raw.declaration : raw;
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) {
      if (decl.id.type === "Identifier" && decl.id.name === name) return decl;
    }
  }
  return undefined;
}

export default {
  id: "no-raw-path-handling",
  type: "check",
  category: "architecture",
  ast: true,
  scold: "raw path handling — use path.isAbsolute / pathEq / canonicalCwd instead",
  guidance: [
    'replace `s.startsWith("/")` with `path.isAbsolute(s)` (handles both Unix and Windows paths)',
    "replace `a === process.cwd()` with `pathEq(a, canonicalCwd())`",
    'import { pathEq, canonicalCwd } from "@mcp-cli/core" for realpath-normalized comparisons',
    "variable-bound form (`const dir = process.cwd(); dir === x`) is caught — use `canonicalCwd()` at the assignment site",
    "Map lookups with raw CWD as key (`cache.get(process.cwd())`) are caught — normalize with `canonicalCwd()` first",
  ],
  documentation: "#2251",
  tests: "exclude",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/")) return ctx.skipped();

    const lines = file.content.split("\n");
    const daemon = file.relativePath.startsWith("packages/daemon/src/");
    const report = (node: TSESTree.Node) =>
      ctx.violated(node.loc.start.line, node.loc.start.column + 1, (lines[node.loc.start.line - 1] ?? "").trim());

    walk(ctx.ast().program, (node) => {
      if (node.type === "CallExpression") {
        // Detection 1: .startsWith("/") or .startsWith("\\\\") as abs-path check.
        // Matches by method name only, not receiver type — any object method named
        // startsWith with a "/" arg is flagged. Use a doing-it-wrong-ignore with a
        // reason for a legitimate non-path startsWith("/") call.
        if (calleeName(node) === "startsWith") {
          const arg = node.arguments[0];
          if (arg?.type === "Literal" && (arg.value === SLASH || arg.value === UNC_PREFIX)) report(node);
        }

        // Detection 3 (daemon only): process.cwd() as the *key* argument (position 0)
        // to Map-like method calls. Only position 0 matters — `.set(key, process.cwd())`
        // puts the cwd in the value position and is not a lookup-key normalization bug.
        if (
          daemon &&
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          MAP_METHODS.has(node.callee.property.name) &&
          node.arguments[0] &&
          isProcessCwd(node.arguments[0])
        ) {
          report(node);
        }
      }

      if (daemon && node.type === "BinaryExpression" && (node.operator === "===" || node.operator === "!==")) {
        // Detection 2: process.cwd() as direct operand of === / !==
        if (isProcessCwd(node.left) || isProcessCwd(node.right)) report(node);

        // Detection 4: identifier compared with === / !== that resolves (by JS
        // scope rules) to a `const` declaration bound to `process.cwd()`.
        const leftHit = node.left.type === "Identifier" && resolvesToCwdConst(node.left);
        const rightHit = node.right.type === "Identifier" && resolvesToCwdConst(node.right);
        if (leftHit || rightHit) report(node);
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
