/**
 * Rule: no-db-ipc-cast
 *
 * Flags field-level `as` casts on values read across the DB/IPC boundary:
 * `row.transport as "ws" | "stdio"`, `payload.kind as MessageKind`, etc.
 * A bare cast is a silent type lie — any garbage value (empty string, NULL,
 * unrecognised literal) passes the compiler and bypasses `?? fallback`
 * defaults. Motivating incident: #2602's `transport` column restore path
 * silently dropped messages on an unconstrained TEXT value.
 *
 * Scope (per #2622): files under a `db/` directory, the IPC protocol/client/
 * server modules, and any file that imports `bun:sqlite` — and within those,
 * only casts whose base identifier conventionally holds a boundary value
 * (`row`, `result`, `data`, `payload`, …). Field-level means the cast operand
 * is a property/element access — whole-row shapes like `stmt.get() as
 * SessionRow` are out of scope (that's the row contract, not a per-field
 * narrowing that dodges a runtime guard).
 *
 * Fix: validate at runtime — a type-guard (`isTransport(v) ? v : "ws"`), a
 * Zod parse, or a CHECK constraint + guarded restore. `as unknown` followed
 * by a narrowing guard is fine; `as const` is fine.
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const SCOPED_PATH_RE = /(^|\/)(db|ipc[^/]*)\.ts$|\/db\//;

function isInScope(relPath: string, content: string): boolean {
  if (relPath.includes("/db/")) return true;
  if (SCOPED_PATH_RE.test(relPath)) return true;
  return content.includes('"bun:sqlite"') || content.includes("'bun:sqlite'");
}

/** Casts that are part of an explicit re-narrowing flow, not a lie. */
function isExemptTargetType(typeNode: TSESTree.TypeNode): boolean {
  if (typeNode.type === "TSUnknownKeyword") return true;
  // `as const` arrives as a TypeReference named "const"
  return (
    typeNode.type === "TSTypeReference" && typeNode.typeName.type === "Identifier" && typeNode.typeName.name === "const"
  );
}

/**
 * Base identifiers that conventionally hold a DB row or a parsed IPC payload
 * (per #2622's pattern spec). Restricting to these keeps casts on in-memory
 * objects (event-bus payloads, config structs) out of scope.
 */
const BOUNDARY_BASE_RE = /^(row|rows|result|results|data|payload|parsed|json|record|records)$/;

/** Property and element accesses are the same thing to the rule, optional chains included. */
function unchain(node: TSESTree.Node): TSESTree.Node {
  return node.type === "ChainExpression" ? node.expression : node;
}

function boundaryBaseName(operand: TSESTree.Node): string | null {
  let node = unchain(operand);
  while (node.type === "MemberExpression") node = unchain(node.object);
  return node.type === "Identifier" ? node.name : null;
}

export default {
  id: "no-db-ipc-cast",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold:
    "field-level `as` cast on a DB/IPC read — garbage values pass the compiler and bypass runtime fallbacks (#2602)",
  guidance: [
    'validate at runtime: a type guard (`isTransport(row.transport) ? row.transport : "ws"`) or a Zod parse',
    "`as unknown` + a narrowing guard is fine; the ban is on casting straight to the target type",
    "whole-row casts (`stmt.get() as SessionRow`) are out of scope — the rule targets per-field narrowing",
    "legitimate exception? suppress with `// doing-it-wrong-ignore no-db-ipc-cast: <reason> (#issue)`",
  ],
  documentation: "#2622",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/")) return ctx.skipped();
    if (!isInScope(file.relativePath, file.content)) return ctx.skipped();

    walk(ctx.ast().program, (node) => {
      if (node.type !== "TSAsExpression") return;
      if (unchain(node.expression).type !== "MemberExpression") return;
      if (isExemptTargetType(node.typeAnnotation)) return;
      const base = boundaryBaseName(node.expression);
      if (base === null || !BOUNDARY_BASE_RE.test(base)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, file.content.split("\n")[line - 1]?.trim() ?? "");
    });
    return ctx.checked();
  },
} satisfies Rule;
