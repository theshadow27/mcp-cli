/**
 * Rule: spec-git-env-spread
 *
 * Test files must not spread `process.env` into the `env` option of a git
 * subprocess call without stripping the git hook variables. When `bun test`
 * runs inside a git pre-push or pre-commit hook, `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, and `GIT_OBJECT_DIRECTORY` are already
 * set in the environment. A naked `{ ...process.env }` spread inherits them —
 * git then ignores any `-C <tempDir>` flag and operates on the **real
 * worktree** instead of the test directory, silently committing, checking out,
 * or rebasing against the real repo.
 *
 * Detection:
 *   Find every spawn/exec call whose first argument (or cmd array element) is
 *   a git command — the string literal `"git"`, a `git …` command string, a
 *   `git` template literal, or an argv array headed by `"git"`. Options are
 *   located per-callee: Bun.spawnSync/execSync at index 1, and the node-form
 *   `spawnSync`/`execFileSync(cmd, args, opts)` at index 2. For each such call,
 *   resolve the `env` option value — tracing through up to one variable
 *   reference — and check whether it spreads `process.env` without an explicit
 *   `GIT_DIR: undefined` strip. The delete-based stripping pattern (`const e =
 *   {...process.env}; delete e.GIT_DIR`) is also recognized as safe.
 *
 * Safe forms (not flagged):
 *   - `env: cleanGitEnv()` — function call, no direct process.env spread
 *   - `{ ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, ... }`
 *   - `const e = {...process.env}; delete e.GIT_DIR; ...; env: e`
 *
 * Non-git subprocesses (bun, node, mcx) that spread process.env into their env
 * are intentionally out of scope — only git-argv spawns are flagged. This
 * means zero day-one suppressions are needed for the common patterns already in
 * this repo (TLS client scripts, mcx stress/import helpers, alias executor).
 *
 * Prior incidents: #2400, #2527, #1347, #1339, #1282, #1267, #1265.
 * Regression in PR #2689 (session-deps.spec.ts, commit 2bf501b5).
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const GIT_HOOK_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]);

// Spawn/exec function names to inspect
const SPAWN_EXEC_NAMES = new Set(["spawn", "spawnSync", "execSync", "execFileSync"]);

// ── helpers ─────────────────────────────────────────────────────────────────

function calleeMethodName(expr: TSESTree.Node): string | undefined {
  if (expr.type === "Identifier") return expr.name;
  if (expr.type === "MemberExpression" && !expr.computed && expr.property.type === "Identifier") {
    return expr.property.name;
  }
  return undefined;
}

/** True when a command string is `git` or begins with `git `. */
function isGitCommandString(text: string): boolean {
  return text === "git" || text.startsWith("git ");
}

/** A string-literal node (not a template). */
function isStringLiteral(node: TSESTree.Node | null | undefined): node is TSESTree.StringLiteral {
  return node?.type === "Literal" && typeof node.value === "string";
}

/**
 * True when the first argument to a spawn/exec call is the string literal
 * "git" (or a git command string / template) or an array whose first element
 * is the string literal "git".
 *
 * Template-literal commands (`execSync(`git init`)`) are recognized via the
 * no-substitution literal text and, for interpolated commands, the template
 * head — otherwise a trivial backtick swap bypasses the rule.
 */
function firstArgIsGit(call: TSESTree.CallExpression): boolean {
  const first = call.arguments[0];
  if (!first) return false;
  if (first.type === "ArrayExpression") {
    const head = first.elements[0];
    return isStringLiteral(head) && head.value === "git";
  }
  if (isStringLiteral(first)) return isGitCommandString(first.value);
  if (first.type === "TemplateLiteral") return isGitCommandString(first.quasis[0]?.value.cooked ?? "");
  return false;
}

/** True when `expr` is exactly `process.env`. */
function isProcessEnv(expr: TSESTree.Node): boolean {
  return (
    expr.type === "MemberExpression" &&
    !expr.computed &&
    expr.object.type === "Identifier" &&
    expr.object.name === "process" &&
    expr.property.type === "Identifier" &&
    expr.property.name === "env"
  );
}

/** A plain `key: value` property (not shorthand, method, spread or computed), with its key name. */
function plainProperty(p: TSESTree.Node): { name: string; value: TSESTree.Node } | undefined {
  if (p.type !== "Property" || p.computed || p.shorthand || p.method || p.kind !== "init") return undefined;
  if (p.key.type === "Identifier") return { name: p.key.name, value: p.value };
  if (isStringLiteral(p.key)) return { name: p.key.value, value: p.value };
  return undefined;
}

/** The value of a named property in an object literal, or undefined. */
function objPropValue(obj: TSESTree.ObjectExpression, name: string): TSESTree.Node | undefined {
  for (const p of obj.properties) {
    const prop = plainProperty(p);
    if (prop?.name === name) return prop.value;
  }
  return undefined;
}

/**
 * Resolve an Identifier to the ObjectExpression it was initialised to,
 * searching all VariableDeclarators in the file. Returns undefined if the
 * initialiser is not a plain object literal (function call, conditional, etc.).
 */
function resolveIdentToObjLit(
  ident: TSESTree.Identifier,
  varDecls: TSESTree.VariableDeclarator[],
): TSESTree.ObjectExpression | undefined {
  for (const decl of varDecls) {
    if (decl.id.type !== "Identifier" || decl.id.name !== ident.name) continue;
    if (!decl.init) continue;
    // Unwrap `as …` casts
    const init = decl.init.type === "TSAsExpression" ? decl.init.expression : decl.init;
    if (init.type === "ObjectExpression") return init;
  }
  return undefined;
}

/** Strip `as` casts recursively to reach the base expression. */
function stripCasts(expr: TSESTree.Node): TSESTree.Node {
  return expr.type === "TSAsExpression" ? stripCasts(expr.expression) : expr;
}

/**
 * True when any `delete varName[…]` or `delete varName.key` expression exists
 * in the collected delete expressions — a heuristic that the variable's
 * GIT_* properties are manually stripped before use.
 */
function varHasAnyDelete(varName: string, deleteExprs: TSESTree.UnaryExpression[]): boolean {
  for (const del of deleteExprs) {
    const op = del.argument;
    if (op.type !== "MemberExpression") continue;
    const obj = stripCasts(op.object);
    if (obj.type === "Identifier" && obj.name === varName) return true;
  }
  return false;
}

/**
 * Find the `...process.env` SpreadElement within an env expression that is
 * missing a GIT_DIR strip. Returns the SpreadElement to report, or undefined
 * if the env is safe (no process.env spread, or GIT_DIR is stripped, or
 * delete-based stripping is present).
 *
 * Handles:
 *   - Inline object literals (including multi-line, since AST is line-agnostic)
 *   - One-level variable indirection: `const e = {...process.env}; ...; env: e`
 *   - Delete-based stripping heuristic
 */
function findUnsafeProcessEnvSpread(
  envExpr: TSESTree.Node,
  varDecls: TSESTree.VariableDeclarator[],
  deleteExprs: TSESTree.UnaryExpression[],
  depth = 0,
): TSESTree.SpreadElement | undefined {
  if (depth > 3) return undefined;

  if (envExpr.type === "ObjectExpression") {
    let spreadNode: TSESTree.SpreadElement | undefined;
    let hasGitDirStrip = false;

    for (const prop of envExpr.properties) {
      if (prop.type === "SpreadElement" && isProcessEnv(prop.argument)) spreadNode = prop;
      const plain = plainProperty(prop);
      // GIT_DIR: undefined (or any other known hook var stripped to undefined)
      if (
        plain &&
        GIT_HOOK_VARS.has(plain.name) &&
        plain.value.type === "Identifier" &&
        plain.value.name === "undefined"
      ) {
        hasGitDirStrip = true;
      }
    }

    return spreadNode && !hasGitDirStrip ? spreadNode : undefined;
  }

  if (envExpr.type === "Identifier") {
    // delete-loop stripping: if the variable has any delete operations, assume safe
    if (varHasAnyDelete(envExpr.name, deleteExprs)) return undefined;

    const obj = resolveIdentToObjLit(envExpr, varDecls);
    if (!obj) return undefined; // function call or unresolvable — conservative: don't flag

    return findUnsafeProcessEnvSpread(obj, varDecls, deleteExprs, depth + 1);
  }

  return undefined; // function call result, conditional, etc. — don't flag
}

/**
 * Extract the value of the `env` property from the spawn/exec call's options
 * argument. Handles both inline object literals and variable references.
 *
 * Signature variants:
 *   Bun.spawnSync(cmd[], opts)     → opts at index 1 (first arg is an array)
 *   execSync(str, opts)            → opts at index 1
 *   execFileSync(file, [args], opts) → opts at index 2 when args are present
 *   node spawnSync(cmd, [args], opts) → opts at index 2 when args are present
 *
 * Bun.spawnSync and node's child_process.spawnSync collide on the name but
 * differ in arity: Bun takes the argv array as the first arg (opts at 1),
 * node takes the command string first with args at index 1 (opts at 2).
 * Disambiguate by whether the first arg is a string (node) vs array (Bun).
 */
function getEnvValue(
  call: TSESTree.CallExpression,
  varDecls: TSESTree.VariableDeclarator[],
): TSESTree.Node | undefined {
  const name = calleeMethodName(call.callee);
  if (!name) return undefined;

  // Node-form spawnSync/execFileSync put args at index 1 and opts at index 2.
  let optIdx = 1;
  if (name === "execFileSync" || name === "spawnSync") {
    const first = call.arguments[0];
    const second = call.arguments[1];
    // Only the string-command form has an args slot; Bun.spawnSync([...], opts)
    // has an array first arg and keeps opts at index 1.
    if (isStringLiteral(first) && second) {
      if (second.type === "ArrayExpression") {
        optIdx = 2;
      } else if (second.type === "Identifier") {
        // Ambiguous: `spawnSync(cmd, argsIdent, opts)` vs `spawnSync(cmd, optsIdent)`.
        // Prefer index 2 only when a third arg exists.
        optIdx = call.arguments[2] ? 2 : 1;
      }
    }
  }

  const optArg = call.arguments[optIdx];
  if (!optArg) return undefined;

  let opts: TSESTree.ObjectExpression | undefined;
  if (optArg.type === "ObjectExpression") opts = optArg;
  else if (optArg.type === "Identifier") opts = resolveIdentToObjLit(optArg, varDecls);
  if (!opts) return undefined;

  return objPropValue(opts, "env");
}

// ── rule ────────────────────────────────────────────────────────────────────

export default {
  id: "spec-git-env-spread",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold:
    "spreading process.env into a git subprocess env inherits GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE from a parent hook — git ignores -C and operates on the real worktree",
  guidance: [
    "use cleanGitEnv() (packages/core/src/git.spec.ts:227) to destructure away the hook vars before spreading",
    "or add GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined alongside the ...process.env spread",
    "delete-based stripping (const e = {...process.env}; delete e.GIT_DIR) is also recognized as safe",
  ],
  documentation: "#2696",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    const varDecls: TSESTree.VariableDeclarator[] = [];
    const deleteExprs: TSESTree.UnaryExpression[] = [];
    const calls: TSESTree.CallExpression[] = [];
    walk(ctx.ast().program, (node) => {
      if (node.type === "VariableDeclarator") varDecls.push(node);
      else if (node.type === "UnaryExpression" && node.operator === "delete") deleteExprs.push(node);
      else if (node.type === "CallExpression") calls.push(node);
    });

    for (const call of calls) {
      const name = calleeMethodName(call.callee);
      if (!name || !SPAWN_EXEC_NAMES.has(name)) continue;
      if (!firstArgIsGit(call)) continue;

      const envExpr = getEnvValue(call, varDecls);
      if (!envExpr) continue;

      const spreadNode = findUnsafeProcessEnvSpread(envExpr, varDecls, deleteExprs);
      if (!spreadNode) continue;

      const { line, column } = spreadNode.argument.loc.start;
      ctx.violated(line, column + 1, lines[line - 1]?.trim() ?? "");
    }
    return ctx.checked();
  },
} satisfies Rule;
