/**
 * Rule: named-timeouts
 *
 * Flag a numeric literal sitting in a timeout/delay position — where the
 * magic number drifts from the constant that should govern it and carries
 * no meaning at the call site (#1938 hardcoded 299000 vs. MAX_TIMEOUT_MS).
 *
 * The rule anchors strictly on the call/argument CONTEXT — never on bare
 * numeric literals elsewhere:
 *
 *   - `setTimeout(fn, <literal>)` — 2nd arg
 *   - `setInterval(fn, <literal>)` — 2nd arg
 *   - `AbortSignal.timeout(<literal>)` — 1st arg
 *   - `{ timeout: <literal> }` and `{ timeoutMs: <literal> }` — option-property
 *
 * Literal `0` is exempt (legitimate next-tick scheduling).
 *
 * Fix: hoist the literal to a `const FOO_MS = 30_000` near the call site,
 * or reuse an existing `*_MS` constant (DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
 * IPC_REQUEST_TIMEOUT_MS, CONNECT_TIMEOUT_MS, …) where one fits.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const TIMER_FN_NAMES = new Set(["setTimeout", "setInterval"]);
const TIMEOUT_OPT_KEYS = new Set(["timeout", "timeoutMs"]);

/**
 * Match a NumericLiteral, optionally wrapped in a unary `+`. Excludes `0`
 * (the next-tick form) and any non-literal expression — variables, member
 * accesses, arithmetic, and template literals all fall through as "named
 * enough" because they carry an identifier the reader can chase.
 */
function flaggedLiteralValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  let inner: ts.Expression = node;
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.PlusToken) {
    inner = inner.operand;
  }
  if (!ts.isNumericLiteral(inner)) return undefined;
  // `0` and `0.0` etc. — next-tick is always allowed.
  if (Number.parseFloat(inner.text) === 0) return undefined;
  return inner.text;
}

/** True for `AbortSignal.timeout` — keep callee-shape matching tight. */
function isAbortSignalTimeout(call: ts.CallExpression): boolean {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "AbortSignal") return false;
  return expr.name.text === "timeout";
}

/** True for a bare `setTimeout(...)` / `setInterval(...)` identifier call (no method form). */
function timerFunctionName(call: ts.CallExpression): string | undefined {
  const expr = call.expression;
  if (!ts.isIdentifier(expr)) return undefined;
  return TIMER_FN_NAMES.has(expr.text) ? expr.text : undefined;
}

/** Resolve a PropertyAssignment's key text (handles identifier and string-literal keys). */
function propertyKeyName(prop: ts.PropertyAssignment): string | undefined {
  const name = prop.name;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

const rule: CheckRule = {
  id: "named-timeouts",
  kind: "check",
  appliesToTests: false,
  scold:
    "timeout/delay is a magic numeric literal — hoist to a named `*_MS` constant so the value carries meaning at the call site and can't drift from related constants",
  guidance: [
    "the failure mechanism: an inline number (`setTimeout(fn, 30000)`, `{ timeoutMs: 5000 }`) drifts from the constant that should govern it (#1938 hardcoded 299000 next to MAX_TIMEOUT_MS=299_000) and tells the reader nothing about what the duration means",
    "fix: hoist to a `const FOO_MS = 30_000` near the call site, or reuse an existing `*_MS` constant where one fits — DEFAULT_TIMEOUT_MS / MAX_TIMEOUT_MS / IPC_REQUEST_TIMEOUT_MS / CONNECT_TIMEOUT_MS / PING_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS …",
    "covers (non-exhaustive): `setTimeout(fn, 30000)`, `setInterval(fn, 3000)`, `AbortSignal.timeout(5000)`, `{ timeout: 10_000 }`, `{ timeoutMs: 5000 }`",
    "literal `0` is allowed (explicit next-tick); any non-literal (variable, expression, template) is treated as named enough",
    "for config-driven durations: validate with `z.number()` and thread a named default — keeps the value tunable and self-documenting",
  ],
  documentation: "#2262",
  check({ file, ast, violated }) {
    const flag = (node: ts.Node): void => {
      const pos = ast.positionOf(node);
      const line = file.content.split("\n")[pos.line - 1] ?? "";
      violated(pos.line, pos.column, line.trim());
    };

    // Call-site checks: setTimeout / setInterval / AbortSignal.timeout.
    for (const call of ast.find(ts.isCallExpression)) {
      const timerName = timerFunctionName(call);
      if (timerName !== undefined) {
        // 2nd arg is the delay; if absent we have nothing to flag.
        const delay = call.arguments[1];
        if (flaggedLiteralValue(delay) !== undefined && delay !== undefined) {
          flag(delay);
        }
        continue;
      }
      if (isAbortSignalTimeout(call)) {
        const ms = call.arguments[0];
        if (flaggedLiteralValue(ms) !== undefined && ms !== undefined) {
          flag(ms);
        }
      }
    }

    // Option-property checks: { timeout: N } and { timeoutMs: N } anywhere.
    // PropertyAssignment is precise — shorthand assignments (`{ timeoutMs }`)
    // already carry an identifier, so they're skipped naturally.
    for (const prop of ast.find(ts.isPropertyAssignment)) {
      const key = propertyKeyName(prop);
      if (!key || !TIMEOUT_OPT_KEYS.has(key)) continue;
      if (flaggedLiteralValue(prop.initializer) === undefined) continue;
      flag(prop.initializer);
    }
  },
};

export default rule;
