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

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const TIMER_FN_NAMES = new Set(["setTimeout", "setInterval"]);
const TIMEOUT_OPT_KEYS = new Set(["timeout", "timeoutMs"]);

/**
 * True for a numeric literal, optionally wrapped in a unary `+`, whose real value is not 0. The
 * parser has already resolved `1_000`, `0x1F4`, `0o755` and `0b111` to their values, so `0x0` and
 * `0_000` are 0 and exempt (next tick) while `0x1f4` is a real delay. Any non-literal expression —
 * variables, member accesses, arithmetic, template literals — falls through as "named enough"
 * because it carries an identifier the reader can chase.
 */
function isMagicDelay(node: TSESTree.Node | undefined): boolean {
  if (node === undefined) return false;
  const inner = node.type === "UnaryExpression" && node.operator === "+" ? node.argument : node;
  return inner.type === "Literal" && typeof inner.value === "number" && inner.value !== 0;
}

/** True for `AbortSignal.timeout` — keep callee-shape matching tight. */
function isAbortSignalTimeout(call: TSESTree.CallExpression): boolean {
  const callee = call.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "AbortSignal" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "timeout"
  );
}

/** True for a bare `setTimeout(...)` / `setInterval(...)` identifier call (no method form). */
function isTimerCall(call: TSESTree.CallExpression): boolean {
  return call.callee.type === "Identifier" && TIMER_FN_NAMES.has(call.callee.name);
}

/** A plain `key: value` property's key text (identifier or string-literal key, not computed). */
function propertyKeyName(prop: TSESTree.Property): string | undefined {
  if (prop.computed || prop.shorthand || prop.method) return undefined;
  const key = prop.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

export default {
  id: "named-timeouts",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
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
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    const flag = (node: TSESTree.Node): void => {
      const line = node.loc.start.line;
      ctx.violated(line, node.loc.start.column + 1, (lines[line - 1] ?? "").trim());
    };

    walk(ctx.ast().program, (node) => {
      // Call-site checks: setTimeout / setInterval (2nd arg) and AbortSignal.timeout (1st arg).
      if (node.type === "CallExpression") {
        const delay = isTimerCall(node)
          ? node.arguments[1]
          : isAbortSignalTimeout(node)
            ? node.arguments[0]
            : undefined;
        if (delay !== undefined && isMagicDelay(delay)) flag(delay);
      }

      // Option-property checks: { timeout: N } and { timeoutMs: N } anywhere. Shorthand
      // (`{ timeoutMs }`) already carries an identifier, so it is skipped.
      if (node.type === "Property" && node.parent?.type === "ObjectExpression") {
        const key = propertyKeyName(node);
        if (key !== undefined && TIMEOUT_OPT_KEYS.has(key) && isMagicDelay(node.value)) flag(node.value);
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
