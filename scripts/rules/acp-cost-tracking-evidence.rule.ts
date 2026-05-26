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
 *   For each such provider found, checks the acp-event-map.spec.ts anchor for
 *   two content signals:
 *     - ["']session_info_update["'] (a test exercises this event type; accepts
 *       any quote style so biome reformatting cannot trigger false failures)
 *     - /^\s*expect\s*\(\s*state\.cost\s*\)/ on a non-comment line — anchored
 *       on the closing paren so state.costPerToken/costFoo don't match, and
 *       lines starting with // or * are excluded to avoid commented-out code
 *   If either signal is absent, the costTracking: true line is flagged.
 *
 * Sources: #2419, flagged in #2391 adversarial review.
 */

import ts from "typescript";
import type { CheckRule, RuleContext } from "./_engine/rule";

const PROVIDER_FILE = "packages/core/src/agent-provider.ts";
const ACP_SPEC = "packages/acp/src/acp-event-map.spec.ts";

function specHasCostEvidence(specContent: string): boolean {
  if (!/["']session_info_update["']/.test(specContent)) return false;
  const costAssertionRe = /^\s*expect\s*\(\s*state\.cost\s*\)/;
  return specContent.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
    return costAssertionRe.test(trimmed);
  });
}

function findPropertyInit(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
      return prop.initializer;
    }
  }
  return undefined;
}

function findPropertyAssignment(obj: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
      return prop;
    }
  }
  return undefined;
}

function checkProviders(ctx: RuleContext, hasEvidence: boolean): void {
  const lines = ctx.file.content.split("\n");
  const sf = ctx.ast.sourceFile;

  function walk(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerProvider" &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isObjectLiteralExpression(arg)) {
        const serverNameVal = findPropertyInit(arg, "serverName");
        if (serverNameVal && ts.isStringLiteral(serverNameVal) && serverNameVal.text === "_acp") {
          const nativeVal = findPropertyInit(arg, "native");
          if (nativeVal && ts.isObjectLiteralExpression(nativeVal)) {
            const costTrackingVal = findPropertyInit(nativeVal, "costTracking");
            if (costTrackingVal && costTrackingVal.kind === ts.SyntaxKind.TrueKeyword && !hasEvidence) {
              const pa = findPropertyAssignment(nativeVal, "costTracking");
              if (pa) {
                const pos = ctx.ast.positionOf(pa);
                ctx.violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sf);
}

const rule: CheckRule = {
  id: "acp-cost-tracking-evidence",
  kind: "check",
  scold: "ACP provider has costTracking: true with no acp-event-map.spec.ts evidence for cost field extraction",
  guidance: [
    "costTracking: true on an ACP provider without a spec test is a capability claim with no evidence — budget-watcher tracks $0.00 per turn forever (80% impl-freeze never fires) and the session display shows '—' (tracked, no data) instead of 'N/A' (not supported)",
    "add a test in acp-event-map.spec.ts that passes a session/update notification with sessionUpdate: 'session_info_update' and a cost field, then asserts expect(state.cost).toBe(<value>) — this proves the ACP event map actually extracts the cost field",
    "the assertion must cover state.cost specifically (not just state.totalTokens) — token-count tests do not prove cost extraction works",
    "if this ACP provider does not actually report cost, set costTracking: false instead",
  ],
  documentation: "#2419",
  appliesToTests: false,
  anchors: [ACP_SPEC],
  check(ctx) {
    if (ctx.file.relPath !== PROVIDER_FILE) return;
    ctx.checked();

    let specContent: string | undefined;
    for (const meta of ctx.files.values()) {
      if (meta.relPath === ACP_SPEC) {
        specContent = meta.content;
        break;
      }
    }

    const hasEvidence = specContent !== undefined && specHasCostEvidence(specContent);
    checkProviders(ctx, hasEvidence);
  },
};

export default rule;
