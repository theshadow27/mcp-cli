/**
 * Rule: agent-protocol-forward-symmetry
 *
 * Every agent-session worker maps provider session events to DB events in a
 * `forwardSessionEvent(sessionId, event)` switch. Providers that consume the
 * same event vocabulary must mirror the same set of session:* cases — a new
 * provider that copy-pastes the pattern but drops a case (e.g. forgets
 * `session:disconnected`) would silently stop persisting that transition. The
 * #2540 review flagged this partial-mirror class as review-only-catchable;
 * this rule catches it at lint time.
 *
 * Symmetry is scoped by the handler's event parameter type, not a hardcoded
 * provider list: acp/codex/opencode/mock all take `AgentSessionEvent` and form
 * one symmetry class; claude takes `SessionEvent` (a different, WS-sourced
 * vocabulary with cleared/rate_limited/model_changed and no permission_request)
 * and forms its own class. Grouping by parameter type means a future provider
 * is auto-classified by the type it declares, and claude's legitimately
 * different vocabulary is not forced into false symmetry.
 *
 * Within a class of ≥2 providers, any provider missing a case that a peer
 * handles is flagged.
 *
 * The other workers' handlers are read with the lexical scanner in `_text-scan.ts`
 * (`ctx.ast()` only parses the file under check): the `event` parameter's type
 * text and the `case "session:*"` labels in the handler body.
 *
 * Source: #2553 item 7, from the #2540 / PR #2546 adversarial review.
 */

import type { Rule, RuleContext, Verdict } from "am-i-done";
import { maskComments, matchingClose } from "./_text-scan";

const ANCHOR = "packages/daemon/src/abstract-worker-server.ts";
const WORKER_SUFFIX = "-session-worker.ts";
const HANDLER = "forwardSessionEvent";

export interface ForwardHandler {
  paramType: string;
  cases: string[];
}

/**
 * Parse the `forwardSessionEvent` handler out of a worker source file: the
 * declared type of its `event` parameter and the sorted set of `session:*`
 * case labels its switch handles. Returns undefined if the file has no such
 * handler.
 */
export function extractForwardHandler(source: string): ForwardHandler | undefined {
  const code = maskComments(source);
  const decl = new RegExp(`\\bfunction\\s+${HANDLER}\\s*(?:<[^>(]*>)?\\s*\\(`).exec(code);
  if (!decl) return undefined;

  const open = decl.index + decl[0].length - 1;
  const close = matchingClose(code, open);
  if (close === -1) return undefined;

  let paramType = "";
  for (const param of splitTopLevel(code.slice(open + 1, close))) {
    const m = /^event\b\s*\??\s*(?::\s*([\s\S]*?))?\s*(?:=[\s\S]*)?$/.exec(param.trim());
    if (m) {
      paramType = (m[1] ?? "").trim();
      break;
    }
  }

  // The body starts at the first `{` after the signature that is not inside type arguments.
  let i = close + 1;
  let angle = 0;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "<") angle++;
    else if (ch === ">" && code[i - 1] !== "=") angle--;
    else if (ch === "{" && angle <= 0) break;
  }
  const bodyEnd = code[i] === "{" ? matchingClose(code, i) : -1;
  const cases = new Set<string>();
  if (bodyEnd !== -1) {
    for (const m of code.slice(i, bodyEnd).matchAll(/\bcase\s+(["'`])(session:(?:(?!\1)[^\\\n$])*)\1\s*:/g)) {
      cases.add(m[2] as string);
    }
  }
  return { paramType, cases: [...cases].sort() };
}

/** `list` split at the commas that are not inside brackets or type arguments. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || (ch === ">" && list[i - 1] !== "=")) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

function providerName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.slice(0, -WORKER_SUFFIX.length);
}

function check(ctx: RuleContext): Verdict {
  if (ctx.file.relativePath !== ANCHOR) return ctx.skipped();

  // provider → handler, keyed within a parameter-type symmetry class.
  const classes = new Map<string, Map<string, ForwardHandler>>();
  for (const f of ctx.files.values()) {
    if (!f.relativePath.endsWith(WORKER_SUFFIX)) continue;
    const handler = extractForwardHandler(f.content);
    if (!handler) continue;
    const key = handler.paramType || "(untyped)";
    let group = classes.get(key);
    if (!group) {
      group = new Map();
      classes.set(key, group);
    }
    group.set(providerName(f.relativePath), handler);
  }

  for (const group of classes.values()) {
    if (group.size < 2) continue; // a lone provider has no peer to mirror
    const union = new Set<string>();
    for (const h of group.values()) for (const c of h.cases) union.add(c);

    for (const [provider, handler] of group) {
      const owned = new Set(handler.cases);
      for (const c of [...union].sort()) {
        if (owned.has(c)) continue;
        const peers = [...group]
          .filter(([, h]) => h.cases.includes(c))
          .map(([p]) => p)
          .sort()
          .join(", ");
        ctx.violated(1, 1, `${provider} forwardSessionEvent omits \`${c}\` handled by peer(s): ${peers}`);
      }
    }
  }
  return ctx.checked();
}

export default {
  id: "agent-protocol-forward-symmetry",
  type: "check",
  category: "architecture",
  files: ["packages/daemon/**/*.ts"],
  anchors: [(files) => files.has(ANCHOR)],
  scold: "forwardSessionEvent is asymmetric across providers that share an event vocabulary",
  guidance: [
    "Providers whose forwardSessionEvent takes the same event parameter type must handle the same set of session:* cases — a dropped case silently stops persisting that state transition.",
    "Add the missing case to the flagged provider, or (if the omission is intentional and correct) document why the vocabularies legitimately differ and split the type.",
    "Symmetry is grouped by the event parameter type: claude's SessionEvent is a separate class from AgentSessionEvent and is not compared against it.",
  ],
  documentation: "docs/agent-protocol.md §6; #2553 item 7",
  check,
} satisfies Rule;
