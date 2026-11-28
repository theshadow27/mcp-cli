/**
 * Rule: acp-cost-tracking-evidence
 *
 * Flag any AgentProvider registration where serverName === "_acp" and
 * native.costTracking === true unless acp-event-map.spec.ts contains a
 * test that exercises the session_info_update path and asserts the cost
 * field from the accumulated state.
 *
 * Without this evidence, budget-watcher tracks $0.00 per turn forever for
 * the provider (80% impl-freeze never fires for sprints using that provider)
 * and the session display shows "—" (tracked, no data) rather than "N/A"
 * (not supported) — actively misleading.
 *
 * Detection strategy:
 *   Only runs on packages/core/src/agent-provider.ts. Finds registerProvider()
 *   calls whose first argument is an object literal with both:
 *     - serverName: "_acp" (top-level string property)
 *     - native.costTracking: true (boolean in the nested native object)
 *   The provider file is read through its syntax tree. For each such provider
 *   found, acp-event-map.spec.ts is scanned (comments blanked, strings kept:
 *   `ctx.ast()` only parses the file under check) for two signals:
 *     - A string literal with text "session_info_update"
 *     - A call `expect(state.cost)` with `state.cost` as its single argument
 *       (exact: state.costPerToken etc. do not match)
 *   Commented-out code, quote style and sibling fields cannot satisfy either
 *   signal. If either signal is absent, the costTracking: true line is flagged.
 *
 * Sources: #2419, flagged in #2391 adversarial review.
 */

import type { FileMeta, Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";
import { maskComments } from "./_text-scan";

const PROVIDER_FILE = "packages/core/src/agent-provider.ts";
const ACP_SPEC = "packages/acp/src/acp-event-map.spec.ts";

const SESSION_INFO_UPDATE = /(["'`])session_info_update\1/;
const EXPECT_STATE_COST = /\bexpect\s*\(\s*state\s*\.\s*cost\s*\)/;

function specHasCostEvidence(spec: FileMeta): boolean {
  const code = maskComments(spec.content);
  return SESSION_INFO_UPDATE.test(code) && EXPECT_STATE_COST.test(code);
}

function findProperty(obj: TSESTree.ObjectExpression, key: string): TSESTree.Property | undefined {
  for (const prop of obj.properties) {
    if (prop.type === "Property" && !prop.computed && prop.key.type === "Identifier" && prop.key.name === key) {
      return prop;
    }
  }
  return undefined;
}

export default {
  id: "acp-cost-tracking-evidence",
  type: "check",
  category: "testing",
  ast: true,
  scold: "ACP provider has costTracking: true with no acp-event-map.spec.ts evidence for cost field extraction",
  guidance: [
    "costTracking: true on an ACP provider without a spec test is a capability claim with no evidence: budget-watcher tracks $0.00 per turn forever (80% impl-freeze never fires) and the session display shows '—' (tracked, no data) instead of 'N/A' (not supported)",
    "add a test in acp-event-map.spec.ts that passes a session/update notification with sessionUpdate: 'session_info_update' and a cost field, then asserts expect(state.cost).toBe(<value>): this proves the ACP event map actually extracts the cost field",
    "the assertion must cover state.cost specifically (not just state.totalTokens): token-count tests do not prove cost extraction works",
    "if this ACP provider does not actually report cost, set costTracking: false instead",
  ],
  documentation: "#2419",
  tests: "exclude",
  anchors: [(files) => files.has(ACP_SPEC)],
  check(ctx) {
    if (ctx.file.relativePath !== PROVIDER_FILE) return ctx.skipped();

    const specFile = ctx.files.get(ACP_SPEC);
    const hasEvidence = specFile !== undefined && specHasCostEvidence(specFile);
    if (hasEvidence) return ctx.checked();

    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
      if (node.callee.name !== "registerProvider") return;
      const arg = node.arguments[0];
      if (arg?.type !== "ObjectExpression") return;

      const serverName = findProperty(arg, "serverName")?.value;
      if (serverName?.type !== "Literal" || serverName.value !== "_acp") return;
      const native = findProperty(arg, "native")?.value;
      if (native?.type !== "ObjectExpression") return;
      const costTracking = findProperty(native, "costTracking");
      if (costTracking?.value.type !== "Literal" || costTracking.value.value !== true) return;

      const { line, column } = costTracking.loc.start;
      ctx.violated(line, column + 1, lines[line - 1]?.trim() ?? "");
    });
    return ctx.checked();
  },
} satisfies Rule;
