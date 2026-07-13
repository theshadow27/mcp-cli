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
 * Source: #2553 item 7, from the #2540 / PR #2546 adversarial review.
 */

import ts from "typescript";
import type { CheckRule, RuleContext } from "./_engine/rule";

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
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  let result: ForwardHandler | undefined;

  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === HANDLER) {
      const eventParam = node.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === "event");
      const paramType = eventParam?.type ? eventParam.type.getText(sf) : "";
      const cases = new Set<string>();
      const collectCases = (n: ts.Node): void => {
        if (ts.isCaseClause(n) && ts.isStringLiteralLike(n.expression) && n.expression.text.startsWith("session:")) {
          cases.add(n.expression.text);
        }
        ts.forEachChild(n, collectCases);
      };
      if (node.body) collectCases(node.body);
      result = { paramType, cases: [...cases].sort() };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

function providerName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.slice(0, -WORKER_SUFFIX.length);
}

function check(ctx: RuleContext): void {
  if (ctx.file.relPath !== ANCHOR) return;
  ctx.checked();

  // provider → handler, keyed within a parameter-type symmetry class.
  const classes = new Map<string, Map<string, ForwardHandler>>();
  for (const f of ctx.files.values()) {
    if (!f.relPath.endsWith(WORKER_SUFFIX)) continue;
    const handler = extractForwardHandler(f.content);
    if (!handler) continue;
    const key = handler.paramType || "(untyped)";
    let group = classes.get(key);
    if (!group) {
      group = new Map();
      classes.set(key, group);
    }
    group.set(providerName(f.relPath), handler);
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
}

const rule: CheckRule = {
  id: "agent-protocol-forward-symmetry",
  kind: "check",
  anchors: [ANCHOR],
  scold: "forwardSessionEvent is asymmetric across providers that share an event vocabulary",
  guidance: [
    "Providers whose forwardSessionEvent takes the same event parameter type must handle the same set of session:* cases — a dropped case silently stops persisting that state transition.",
    "Add the missing case to the flagged provider, or (if the omission is intentional and correct) document why the vocabularies legitimately differ and split the type.",
    "Symmetry is grouped by the event parameter type: claude's SessionEvent is a separate class from AgentSessionEvent and is not compared against it.",
  ],
  documentation: "docs/agent-protocol.md §6; #2553 item 7",
  check,
};

export default rule;
