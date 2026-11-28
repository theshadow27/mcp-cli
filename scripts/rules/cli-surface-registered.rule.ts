/**
 * Rule: cli-surface-registered
 *
 * Keeps three surfaces of the CLI in step:
 *   - the `switch (command)` dispatch in main.ts and `SUBCOMMANDS` in completions.ts, both ways;
 *   - each command file's parsed `--flag`s and its `KNOWN_FLAGS` set, both ways.
 *
 * The file being checked is the only one the engine hands out a syntax tree for, so the other
 * half of a cross-file comparison (the dispatch set seen from completions.ts, `SUBCOMMANDS` seen
 * from main.ts) is read from that file's text with the small scanners below.
 */

import type { Rule, RuleContext, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const MAIN_REL = "packages/command/src/main.ts";
const COMPLETIONS_REL = "packages/command/src/commands/completions.ts";
const COMMANDS_DIR = "packages/command/src/commands/";

interface NamedLocation {
  name: string;
  line: number;
  col: number;
}

const stringValue = (node: TSESTree.Node | null | undefined): string | undefined =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

const locationOf = (node: TSESTree.Node, name: string): NamedLocation => ({
  name,
  line: node.loc.start.line,
  col: node.loc.start.column + 1,
});

/** The elements of `declared = [...]`, `declared = new Set([...])`, with an optional `as const`. */
function declaredStrings(program: TSESTree.Program, declared: string, allowNew: boolean): NamedLocation[] | null {
  let found: NamedLocation[] | null = null;
  walk(program, (node) => {
    if (found !== null) return;
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || node.id.name !== declared) return;
    let init: TSESTree.Node | null | undefined = node.init;
    if (init?.type === "TSAsExpression") init = init.expression;
    if (allowNew && init?.type === "NewExpression") init = init.arguments[0];
    if (init?.type !== "ArrayExpression") return;
    found = init.elements.flatMap((elem) => {
      const text = stringValue(elem);
      return elem !== null && text !== undefined ? [locationOf(elem, text)] : [];
    });
  });
  return found;
}

// ── dispatch (main.ts) ───────────────────────────────────────────────────

/** True when `node` sits anywhere under a `switch` statement. */
function insideSwitch(node: TSESTree.Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === "SwitchStatement") return true;
  return false;
}

/** String `case`s of every outermost `switch (command)`. */
function collectSwitchCases(program: TSESTree.Program): NamedLocation[] {
  const results: NamedLocation[] = [];
  walk(program, (node) => {
    if (node.type !== "SwitchStatement") return;
    if (node.discriminant.type !== "Identifier" || node.discriminant.name !== "command") return;
    if (insideSwitch(node)) return;
    for (const clause of node.cases) {
      const name = stringValue(clause.test);
      if (name !== undefined && clause.test) results.push(locationOf(clause.test, name));
    }
  });
  return results;
}

// ── flags (commands/*.ts) ────────────────────────────────────────────────

const HELP_FLAGS = new Set(["--help", "-h"]);

/** `x.indexOf(...)`, `indexOf(...)`, `x["indexOf"](...)`. */
function calleeName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed) return callee.property.type === "Identifier" ? callee.property.name : undefined;
  return stringValue(callee.property);
}

function collectParsedFlags(program: TSESTree.Program): Map<string, { line: number; col: number }> {
  const result = new Map<string, { line: number; col: number }>();

  function addFlag(text: string, node: TSESTree.Node) {
    // Accept both long (`--foo`) and short (`-h`) flag literals so the two
    // directions of the check are symmetric — the reverse direction iterates
    // every KNOWN_FLAGS entry, and excluding short flags here would mean a
    // KNOWN_FLAGS entry like `-h` could never be matched as "parsed".
    if (!text.startsWith("-")) return;
    if (HELP_FLAGS.has(text)) return;
    if (result.has(text)) return;
    result.set(text, { line: node.loc.start.line, col: node.loc.start.column + 1 });
  }

  walk(program, (node) => {
    if (node.type === "SwitchCase" && node.test) {
      const text = stringValue(node.test);
      if (text !== undefined) addFlag(text, node.test);
    }
    if (node.type === "BinaryExpression" && node.operator === "===") {
      for (const side of [node.left, node.right]) {
        const text = stringValue(side);
        if (text !== undefined) addFlag(text, side);
      }
    }
    if (node.type === "CallExpression") {
      const name = calleeName(node);
      const arg = node.arguments[0];
      const text = name === "indexOf" || name === "includes" ? stringValue(arg) : undefined;
      if (text !== undefined && arg) addFlag(text, arg);
    }
  });
  return result;
}

// ── text scanners for the file the engine gives no tree for ──────────────

/**
 * `code` with comments blanked, and `shape` with strings blanked too (quotes kept), both the same
 * length as `source` so an offset in one is an offset in the other.
 */
function blank(source: string): { code: string; shape: string } {
  const code = [...source];
  const shape = [...source];
  const wipe = (view: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (view[k] !== "\n") view[k] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
      wipe(code, i, end);
      wipe(shape, i, end);
      i = end;
    } else if (ch === "/" && next === "*") {
      let end = source.indexOf("*/", i + 2);
      end = end === -1 ? source.length : end + 2;
      wipe(code, i, end);
      wipe(shape, i, end);
      i = end;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let end = i + 1;
      while (end < source.length && source[end] !== ch) end += source[end] === "\\" ? 2 : 1;
      wipe(shape, i + 1, end);
      i = end + 1;
    } else {
      i++;
    }
  }
  return { code: code.join(""), shape: shape.join("") };
}

/** The string literals of `SUBCOMMANDS = [...]` as written in `source`, or null when absent. */
function subcommandsFromText(source: string): Set<string> | null {
  const { code, shape } = blank(source);
  const declaration = /\bSUBCOMMANDS\b[^=;\n]*=\s*\[/.exec(shape);
  if (!declaration) return null;
  const open = declaration.index + declaration[0].length;
  const close = shape.indexOf("]", open);
  const body = code.slice(open, close === -1 ? undefined : close);
  return new Set([...body.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2] as string));
}

/** Command names main.ts dispatches: outermost `switch (command)` cases, plus `args[0] === "name"`. */
function dispatchedFromText(source: string): Set<string> {
  const { code, shape } = blank(source);
  const result = new Set<string>();

  // Every `switch (command) {` block, as the span from the keyword to its closing brace.
  const blocks = [...shape.matchAll(/\bswitch\s*\(\s*command\s*\)\s*\{/g)].map((m) => {
    const open = m.index + m[0].length;
    let depth = 1;
    let end = open;
    while (end < shape.length && depth > 0) {
      if (shape[end] === "{") depth++;
      else if (shape[end] === "}") depth--;
      end++;
    }
    return { start: m.index, open, end };
  });

  for (const block of blocks) {
    if (blocks.some((other) => other.start < block.start && block.start < other.end)) continue; // nested
    let depth = 1;
    for (let k = block.open; k < block.end - 1; k++) {
      if (shape[k] === "{") depth++;
      else if (shape[k] === "}") depth--;
      else if (depth === 1 && shape[k] === "c" && !/\w/.test(shape[k - 1] ?? " ")) {
        const clause = /^case\s*(["'])( *)\1\s*:/.exec(shape.slice(k, k + 200));
        if (clause) {
          const from = k + clause[0].indexOf(clause[1] as string) + 1;
          result.add(code.slice(from, from + (clause[2] as string).length));
        }
      }
    }
  }

  for (const m of shape.matchAll(/(["'])( *)\1\s*===\s*args\[\s*0\s*\]|args\[\s*0\s*\]\s*===\s*(["'])( *)\3/g)) {
    const at = m.index + m[0].search(/["']/) + 1;
    const length = (m[2] ?? m[4] ?? "").length;
    const name = code.slice(at, at + length);
    if (!name.startsWith("-")) result.add(name);
  }
  return result;
}

// ── Rule ─────────────────────────────────────────────────────────────────

/** main.ts: every `switch (command)` case is in SUBCOMMANDS. True when it had cases to check. */
function checkDispatchToSubcommands(ctx: RuleContext): boolean {
  const cases = collectSwitchCases(ctx.ast().program);
  if (cases.length === 0) return false;

  const local = declaredStrings(ctx.ast().program, "SUBCOMMANDS", false);
  const completions = ctx.files.get(COMPLETIONS_REL);
  const subcommands = local
    ? new Set(local.map((e) => e.name))
    : completions
      ? subcommandsFromText(completions.content)
      : null;
  if (!subcommands) {
    ctx.violated(1, 1, `SUBCOMMANDS anchor not found — is ${COMPLETIONS_REL} missing or renamed?`);
    return true;
  }

  for (const { name, line, col } of cases) {
    if (!subcommands.has(name)) ctx.violated(line, col, `case "${name}"`);
  }
  return true;
}

/** completions.ts: every SUBCOMMANDS entry has a dispatch case in main.ts. True when it had entries. */
function checkSubcommandsToDispatch(ctx: RuleContext): boolean {
  const entries = declaredStrings(ctx.ast().program, "SUBCOMMANDS", false);
  if (!entries) return false;

  const main = ctx.files.get(MAIN_REL);
  if (!main) return true;
  const dispatched = dispatchedFromText(main.content);
  for (const { name, line, col } of entries) {
    if (!dispatched.has(name)) ctx.violated(line, col, `SUBCOMMANDS entry "${name}" has no dispatch case`);
  }
  return true;
}

/** commands/*.ts: parsed flags and KNOWN_FLAGS agree. True when the file declares KNOWN_FLAGS. */
function checkFlagKnownFlags(ctx: RuleContext): boolean {
  const entries = declaredStrings(ctx.ast().program, "KNOWN_FLAGS", true);
  if (!entries) return false;
  const known = new Set(entries.map((e) => e.name));
  const parsed = collectParsedFlags(ctx.ast().program);

  for (const [flag, { line, col }] of parsed) {
    if (!known.has(flag)) ctx.violated(line, col, `flag "${flag}" parsed but not in KNOWN_FLAGS`);
  }

  for (const { name, line, col } of entries) {
    // Skip help flags in the reverse direction too — they're handled centrally
    // (not per-command parse) and would otherwise be unmatchable when listed
    // in a per-command KNOWN_FLAGS for documentation/completion purposes.
    if (HELP_FLAGS.has(name)) continue;
    if (!parsed.has(name)) ctx.violated(line, col, `KNOWN_FLAGS entry "${name}" not parsed anywhere`);
  }
  return true;
}

export default {
  id: "cli-surface-registered",
  type: "check",
  category: "architecture",
  ast: true,
  tests: "exclude",
  scold: "CLI surface registration mismatch — command or flag set out of sync with its anchor",
  guidance: [
    "dispatch case without SUBCOMMANDS entry → add to SUBCOMMANDS in completions.ts",
    "SUBCOMMANDS entry without dispatch case → remove from SUBCOMMANDS or add case in main.ts",
    "parsed --flag missing from KNOWN_FLAGS → add to the KNOWN_FLAGS set in the same file",
    "KNOWN_FLAGS entry not parsed anywhere → remove from KNOWN_FLAGS or add code that handles it",
  ],
  documentation: "#2246, #2314, #2315, #2327",
  // A rename or filter-narrowing that hides these would otherwise silently no-op the rule. See #2315.
  anchors: [(files) => files.has(MAIN_REL), (files) => files.has(COMPLETIONS_REL)],
  check(ctx) {
    const path = ctx.file.relativePath;
    let inspected = false;
    if (path === MAIN_REL) inspected = checkDispatchToSubcommands(ctx) || inspected;
    if (path === COMPLETIONS_REL) inspected = checkSubcommandsToDispatch(ctx) || inspected;
    if (path.startsWith(COMMANDS_DIR)) inspected = checkFlagKnownFlags(ctx) || inspected;
    return inspected ? ctx.checked() : ctx.skipped();
  },
} satisfies Rule;
