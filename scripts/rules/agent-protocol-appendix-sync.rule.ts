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
 * Neither the spec nor the worker files are read from disk: the rule's `files`
 * include docs/agent-protocol.md and the daemon sources, and it reads them from
 * `ctx.files`. The Set constants of the other daemon files are read with the
 * lexical scanner in `_text-scan.ts` (`ctx.ast()` only parses the file under check).
 *
 * Source: #2553 item 6, from the #2540 / PR #2546 adversarial review.
 */

import type { Rule, RuleContext, Verdict } from "am-i-done";
import { maskComments, matchingClose, stringLiteralValues } from "./_text-scan";

const ANCHOR = "packages/daemon/src/abstract-worker-server.ts";
const SPEC_REL_PATH = "docs/agent-protocol.md";
const DAEMON_DIR = "packages/daemon/";

const WORKER_TABLE_HEADING = "Worker → Daemon"; // "Worker → Daemon"
const CONTROL_TABLE_HEADING = "Daemon → Worker"; // "Daemon → Worker"

/**
 * Collect the string-literal members of a `const <name> = new Set(...)`
 * declaration. Spread elements (`...OTHER_SET`) contribute no literals and are
 * ignored — callers union the referenced set separately. Returns [] if the
 * const is absent or is not initialized from a Set.
 */
export function setLiteralValues(source: string, constName: string): string[] {
  const code = maskComments(source);
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${constName}\\b[^=;]*=\\s*new\\s+Set\\b`, "g");
  const out: string[] = [];
  for (const m of code.matchAll(declaration)) {
    // Skip the optional type arguments, then take the constructor's argument list.
    let i = m.index + m[0].length;
    let angle = 0;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "<") angle++;
      else if (ch === ">") angle--;
      else if (ch === "(" && angle === 0) break;
      else if (ch === ";" && angle === 0) break;
    }
    if (code[i] !== "(") continue; // `new Set` with no argument list
    const close = matchingClose(code, i);
    if (close === -1) continue;
    out.push(...stringLiteralValues(code.slice(i + 1, close)));
  }
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
    if (m?.[1] !== undefined) types.add(m[1]);
  }
  return types;
}

function check(ctx: RuleContext): Verdict {
  if (ctx.file.relativePath !== ANCHOR) return ctx.skipped();

  // Worker → daemon events: BASE plus any provider WORKER_EVENT_TYPES extension.
  const workerEvents = new Set(setLiteralValues(ctx.file.content, "BASE_WORKER_EVENT_TYPES"));
  // Daemon → worker control messages: union across every worker file.
  const controlTypes = new Set<string>();
  for (const f of ctx.files.values()) {
    if (!f.relativePath.startsWith(DAEMON_DIR)) continue;
    for (const t of setLiteralValues(f.content, "WORKER_EVENT_TYPES")) workerEvents.add(t);
    for (const t of setLiteralValues(f.content, "CONTROL_MESSAGE_TYPES")) controlTypes.add(t);
  }

  if (workerEvents.size === 0) {
    ctx.violated(1, 1, "BASE_WORKER_EVENT_TYPES not found or empty: cannot verify Appendix A coverage");
    return ctx.checked();
  }

  const spec = ctx.files.get(SPEC_REL_PATH);
  if (spec === undefined) {
    ctx.violated(1, 1, `${SPEC_REL_PATH} not found: cannot verify Appendix A coverage`);
    return ctx.checked();
  }

  const specWorker = appendixTypes(spec.content, WORKER_TABLE_HEADING);
  const specControl = appendixTypes(spec.content, CONTROL_TABLE_HEADING);

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
  return ctx.checked();
}

export default {
  id: "agent-protocol-appendix-sync",
  type: "check",
  category: "architecture",
  files: ["packages/daemon/**/*.ts", SPEC_REL_PATH],
  anchors: [(files) => files.has(ANCHOR), (files) => files.has(SPEC_REL_PATH)],
  scold: "Appendix A of docs/agent-protocol.md is missing a message type that exists in code",
  guidance: [
    "Appendix A must list every worker→daemon event type (BASE_WORKER_EVENT_TYPES + provider WORKER_EVENT_TYPES extensions) and every daemon→worker control type (union of CONTROL_MESSAGE_TYPES).",
    "When you add or rename a wire message type, add/rename the matching Appendix A row (and its §-referenced body section) so the spec stays a complete reference.",
    "Direction is code → spec: spec-only rows like `error` (a startup control reply, not a BaseWorkerEvent) are allowed and not flagged.",
  ],
  documentation: "docs/agent-protocol.md Appendix A; #2553 item 6",
  check,
} satisfies Rule;
