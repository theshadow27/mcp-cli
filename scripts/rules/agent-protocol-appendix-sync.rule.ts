/**
 * Rule: agent-protocol-appendix-sync
 *
 * Appendix A of docs/agent-protocol.md is a "Complete Message Type Reference"
 * — a table inventory of every message type on the daemon↔worker wire. The
 * point of a spec is defeated if that inventory silently drifts from the real
 * wire format, which is exactly what the #2540 adversarial review found (a
 * type present in code but missing from the spec).
 *
 * This rule makes the spec self-enforcing against type-set drift. It derives
 * the authoritative type sets from source:
 *   - worker → daemon events: BASE_WORKER_EVENT_TYPES (abstract-worker-server.ts)
 *     plus any per-provider extension declared in a WORKER_EVENT_TYPES set
 *     (e.g. claude-server.ts adds "monitor:event").
 *   - daemon → worker control messages: the union of every CONTROL_MESSAGE_TYPES
 *     set across the worker files.
 * ...then asserts every derived type appears in the corresponding Appendix A
 * table. The direction is code → spec: a type in code that the spec omits or
 * misnames fails. Spec-only rows (e.g. `error`, which is a startup-window
 * control reply and not a BaseWorkerEvent, or the bidirectional MCP row) are
 * allowed — the rule never forces the spec to drop documentation for things
 * outside these Set constants.
 *
 * docs/ is outside the file-loader scan roots, so the spec is read from disk
 * directly (same approach as protocol-version-spec-sync).
 *
 * Source: #2553 item 6, from the #2540 / PR #2546 adversarial review.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { CheckRule, RuleContext } from "./_engine/rule";

const ANCHOR = "packages/daemon/src/abstract-worker-server.ts";
const SPEC_REL_PATH = "docs/agent-protocol.md";

const WORKER_TABLE_HEADING = "Worker → Daemon"; // "Worker → Daemon"
const CONTROL_TABLE_HEADING = "Daemon → Worker"; // "Daemon → Worker"

/**
 * Collect the string-literal members of a `const <name> = new Set(...)`
 * declaration. Spread elements (`...OTHER_SET`) contribute no literals and are
 * ignored — callers union the referenced set separately. Returns [] if the
 * const is absent or is not initialized from a Set.
 */
export function setLiteralValues(source: string, constName: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === constName &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "Set"
    ) {
      const walkLiterals = (n: ts.Node): void => {
        if (ts.isStringLiteralLike(n)) out.push(n.text);
        ts.forEachChild(n, walkLiterals);
      };
      const arg = node.initializer.arguments?.[0];
      if (arg) walkLiterals(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Extract the type names listed in an Appendix A table. `heading` is the `### `
 * section title (e.g. "Worker → Daemon"); rows below it look like
 * `| \`db:upsert\` | all | §4.1 |`. The first backtick-quoted token on each
 * table row is the type. Parsing stops at the next `#` heading.
 */
export function appendixTypes(specContent: string, heading: string): Set<string> {
  const lines = specContent.split("\n");
  const types = new Set<string>();
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      inSection = line.replace(/^#+\s*/, "").trim() === heading;
      continue;
    }
    if (!inSection) continue;
    if (!line.trimStart().startsWith("|")) continue;
    const m = /`([^`]+)`/.exec(line);
    if (m) types.add(m[1]);
  }
  return types;
}

function readSpec(anchorPath: string): string | undefined {
  const repoRoot = resolve(anchorPath, "../../../..");
  try {
    return readFileSync(resolve(repoRoot, SPEC_REL_PATH), "utf8");
  } catch {
    return undefined;
  }
}

function check(ctx: RuleContext): void {
  if (ctx.file.relPath !== ANCHOR) return;
  ctx.checked();

  // Worker → daemon events: BASE plus any provider WORKER_EVENT_TYPES extension.
  const workerEvents = new Set(setLiteralValues(ctx.file.content, "BASE_WORKER_EVENT_TYPES"));
  // Daemon → worker control messages: union across every worker file.
  const controlTypes = new Set<string>();
  for (const f of ctx.files.values()) {
    if (f.pkg !== "packages/daemon") continue;
    for (const t of setLiteralValues(f.content, "WORKER_EVENT_TYPES")) workerEvents.add(t);
    for (const t of setLiteralValues(f.content, "CONTROL_MESSAGE_TYPES")) controlTypes.add(t);
  }

  if (workerEvents.size === 0) {
    ctx.violated(1, 1, "BASE_WORKER_EVENT_TYPES not found or empty — cannot verify Appendix A coverage");
    return;
  }

  const spec = readSpec(ctx.file.path);
  if (spec === undefined) {
    ctx.violated(1, 1, `${SPEC_REL_PATH} not found on disk — cannot verify Appendix A coverage`);
    return;
  }

  const specWorker = appendixTypes(spec, WORKER_TABLE_HEADING);
  const specControl = appendixTypes(spec, CONTROL_TABLE_HEADING);

  for (const t of [...workerEvents].sort()) {
    if (!specWorker.has(t)) {
      ctx.violated(1, 1, `Appendix A (Worker → Daemon) omits worker event type \`${t}\``);
    }
  }
  for (const t of [...controlTypes].sort()) {
    if (!specControl.has(t)) {
      ctx.violated(1, 1, `Appendix A (Daemon → Worker) omits control message type \`${t}\``);
    }
  }
}

const rule: CheckRule = {
  id: "agent-protocol-appendix-sync",
  kind: "check",
  anchors: [ANCHOR],
  scold: "Appendix A of docs/agent-protocol.md is missing a message type that exists in code",
  guidance: [
    "Appendix A must list every worker→daemon event type (BASE_WORKER_EVENT_TYPES + provider WORKER_EVENT_TYPES extensions) and every daemon→worker control type (union of CONTROL_MESSAGE_TYPES).",
    "When you add or rename a wire message type, add/rename the matching Appendix A row (and its §-referenced body section) so the spec stays a complete reference.",
    "Direction is code → spec: spec-only rows like `error` (a startup control reply, not a BaseWorkerEvent) are allowed and not flagged.",
  ],
  documentation: "docs/agent-protocol.md Appendix A; #2553 item 6",
  check,
};

export default rule;
