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

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const GIT_HOOK_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]);

// Spawn/exec function names to inspect
const SPAWN_EXEC_NAMES = new Set(["spawn", "spawnSync", "execSync", "execFileSync"]);

// ── helpers ─────────────────────────────────────────────────────────────────

function calleeMethodName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** True when a command string is `git` or begins with `git `. */
function isGitCommandString(text: string): boolean {
  return text === "git" || text.startsWith("git ");
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
function firstArgIsGit(call: ts.CallExpression): boolean {
  const first = call.arguments[0];
  if (!first) return false;
  if (ts.isArrayLiteralExpression(first)) {
    const head = first.elements[0];
    return !!head && ts.isStringLiteral(head) && head.text === "git";
  }
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return isGitCommandString(first.text);
  }
  if (ts.isTemplateExpression(first)) {
    return isGitCommandString(first.head.text);
  }
  return false;
}

/**
 * True when `expr` is exactly `process.env`.
 */
function isProcessEnv(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "process" &&
    expr.name.text === "env"
  );
}

/**
 * Return the value of a named property in an object literal, or undefined.
 */
function objPropValue(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const k = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (k === name) return p.initializer;
  }
  return undefined;
}

/**
 * Resolve an Identifier to the ObjectLiteralExpression it was initialised to,
 * searching all VariableDeclarations in the file. Returns undefined if the
 * initialiser is not a plain object literal (function call, conditional, etc.).
 */
function resolveIdentToObjLit(
  ident: ts.Identifier,
  varDecls: ts.VariableDeclaration[],
): ts.ObjectLiteralExpression | undefined {
  for (const decl of varDecls) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== ident.text) continue;
    if (!decl.initializer) continue;
    // Unwrap `as …` casts
    const init = ts.isAsExpression(decl.initializer) ? decl.initializer.expression : decl.initializer;
    if (ts.isObjectLiteralExpression(init)) return init;
  }
  return undefined;
}

/**
 * True when any `delete varName[…]` or `delete varName.key` expression exists
 * in the collected delete expressions — a heuristic that the variable's
 * GIT_* properties are manually stripped before use.
 */
/** Strip `as` casts and parentheses recursively to reach the base expression. */
function stripCasts(expr: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expr)) return stripCasts(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return stripCasts(expr.expression);
  return expr;
}

function varHasAnyDelete(varName: string, deleteExprs: ts.DeleteExpression[]): boolean {
  for (const del of deleteExprs) {
    const op = del.expression;
    const rawObj = ts.isElementAccessExpression(op)
      ? op.expression
      : ts.isPropertyAccessExpression(op)
        ? op.expression
        : undefined;
    if (!rawObj) continue;
    const obj = stripCasts(rawObj);
    if (ts.isIdentifier(obj) && obj.text === varName) return true;
  }
  return false;
}

/**
 * Find the `...process.env` SpreadAssignment within an env expression that is
 * missing a GIT_DIR strip. Returns the SpreadAssignment to report, or undefined
 * if the env is safe (no process.env spread, or GIT_DIR is stripped, or
 * delete-based stripping is present).
 *
 * Handles:
 *   - Inline object literals (including multi-line, since AST is line-agnostic)
 *   - One-level variable indirection: `const e = {...process.env}; ...; env: e`
 *   - Delete-based stripping heuristic
 */
function findUnsafeProcessEnvSpread(
  envExpr: ts.Expression,
  varDecls: ts.VariableDeclaration[],
  deleteExprs: ts.DeleteExpression[],
  depth = 0,
): ts.SpreadAssignment | undefined {
  if (depth > 3) return undefined;

  if (ts.isObjectLiteralExpression(envExpr)) {
    let spreadNode: ts.SpreadAssignment | undefined;
    let hasGitDirStrip = false;

    for (const prop of envExpr.properties) {
      if (ts.isSpreadAssignment(prop) && isProcessEnv(prop.expression)) {
        spreadNode = prop;
      }
      if (ts.isPropertyAssignment(prop)) {
        const k = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteral(prop.name) ? prop.name.text : "";
        // GIT_DIR: undefined (or any other known hook var stripped to undefined)
        if (GIT_HOOK_VARS.has(k) && ts.isIdentifier(prop.initializer) && prop.initializer.text === "undefined") {
          hasGitDirStrip = true;
        }
      }
    }

    if (spreadNode && !hasGitDirStrip) return spreadNode;
    return undefined;
  }

  if (ts.isIdentifier(envExpr)) {
    // delete-loop stripping: if the variable has any delete operations, assume safe
    if (varHasAnyDelete(envExpr.text, deleteExprs)) return undefined;

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
function getEnvValue(call: ts.CallExpression, varDecls: ts.VariableDeclaration[]): ts.Expression | undefined {
  const name = calleeMethodName(call.expression);
  if (!name) return undefined;

  // Node-form spawnSync/execFileSync put args at index 1 and opts at index 2.
  let optIdx = 1;
  if (name === "execFileSync" || name === "spawnSync") {
    const first = call.arguments[0];
    const second = call.arguments[1];
    // Only the string-command form has an args slot; Bun.spawnSync([...], opts)
    // has an array first arg and keeps opts at index 1.
    if (first && ts.isStringLiteral(first) && second) {
      if (ts.isArrayLiteralExpression(second)) {
        optIdx = 2;
      } else if (ts.isIdentifier(second)) {
        // Ambiguous: `spawnSync(cmd, argsIdent, opts)` vs `spawnSync(cmd, optsIdent)`.
        // Prefer index 2 only when a third arg exists.
        optIdx = call.arguments[2] ? 2 : 1;
      }
    }
  }

  const optArg = call.arguments[optIdx];
  if (!optArg) return undefined;

  let opts: ts.ObjectLiteralExpression | undefined;
  if (ts.isObjectLiteralExpression(optArg)) {
    opts = optArg;
  } else if (ts.isIdentifier(optArg)) {
    opts = resolveIdentToObjLit(optArg, varDecls);
  }
  if (!opts) return undefined;

  return objPropValue(opts, "env");
}

// ── rule ────────────────────────────────────────────────────────────────────

const rule: CheckRule = {
  id: "spec-git-env-spread",
  kind: "check",
  appliesToTests: true,
  scold:
    "spreading process.env into a git subprocess env inherits GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE from a parent hook — git ignores -C and operates on the real worktree",
  guidance: [
    "use cleanGitEnv() (packages/core/src/git.spec.ts:227) to destructure away the hook vars before spreading",
    "or add GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined alongside the ...process.env spread",
    "delete-based stripping (const e = {...process.env}; delete e.GIT_DIR) is also recognized as safe",
  ],
  documentation: "#2696",
  check({ file, violated, checked, ast }) {
    const sf = ast.sourceFile;
    const varDecls = ast.find(ts.isVariableDeclaration);
    const deleteExprs = ast.find(ts.isDeleteExpression);

    for (const call of ast.find(ts.isCallExpression)) {
      const name = calleeMethodName(call.expression);
      if (!name || !SPAWN_EXEC_NAMES.has(name)) continue;
      if (!firstArgIsGit(call)) continue;

      const envExpr = getEnvValue(call, varDecls);
      if (!envExpr) continue;

      const spreadNode = findUnsafeProcessEnvSpread(envExpr, varDecls, deleteExprs);
      if (!spreadNode) continue;

      const { line, column } = ast.positionOf(spreadNode.expression);
      violated(line, column, file.content.split("\n")[line - 1]?.trim() ?? "");
    }
    checked();
  },
};

export default rule;
