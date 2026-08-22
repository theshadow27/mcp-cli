/**
 * Rule: session-wait-domain-scoped
 *
 * A session worker that filters `handleSessionList` by domain must filter
 * `handleWait` by domain too.
 *
 * `agent_sessions` is partitioned by `domain_id` (#3039, `docs/domains.md`). The
 * daemon resolves the domain once and injects `domainId` into the args of EVERY
 * provider's `session_list` and `wait` — the shared tool schema advertises it for
 * both. But the enforcement lives in five separate worker files, and the first time
 * this shipped, four of them honoured the filter on `session_list` and silently
 * dropped it on `wait` twenty lines below: the any-session path raced every session
 * in the process, and the timeout fallback dumped every domain's session list to a
 * caller that asked for one domain.
 *
 * That is the read-path half of the same asymmetry the domain arc keeps producing —
 * a partition written on more paths than it is read on. `ls` enforced the boundary,
 * `wait` ignored it, and an orchestrator blocking on `wait` read a completion for a
 * session it does not own.
 *
 * The invariant is "both read paths honour the partition", which is a real
 * architectural property rather than de-duplication: the five workers are allowed to
 * diverge in every other respect. This rule is deliberately keyed off
 * `handleSessionList` already being scoped, so it activates on exactly the files that
 * have opted into the partition and cannot be satisfied by removing scoping from both.
 */

import type { CheckRule } from "./_engine/rule";

/** The daemon-injected filter every worker reads through the one shared helper. */
const READS_FILTER = "domainFilterArg(args)";

/**
 * Source text of a top-level function, from its declaration to the next one.
 *
 * Deliberately NOT brace matching from the first `{` after the declaration: these
 * workers are written as
 *
 *   function handleSessionList(args: Record<string, unknown>): { content: ... } {
 *
 * so the first brace belongs to the RETURN TYPE, and matching from it closes at the
 * end of the annotation. That yielded an empty-looking body, the rule concluded the
 * file had not opted into the partition, and it silently passed on four of the five
 * workers — the same silent-pass shape the rule exists to catch. Top-level `function`
 * declarations start at column 0 in every session worker, which makes them a reliable
 * boundary and needs no parser.
 */
function functionRegion(source: string, name: string): string | null {
  const lines = source.split("\n");
  const startsFn = (line: string) => /^(?:export\s+)?(?:async\s+)?function\s+\w+/.test(line);
  const start = lines.findIndex((line) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(line),
  );
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (startsFn(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const rule: CheckRule = {
  id: "session-wait-domain-scoped",
  kind: "check",
  scold:
    "handleSessionList honours the domain partition but handleWait does not — a scoped wait will wake on another domain's session",
  guidance: [
    "read the daemon-injected filter in handleWait: `const domainId = domainFilterArg(args);`",
    "filter the any-session set, the buffered afterSeq replay, and the timeout fallback list",
    "an event whose session is gone cannot be attributed — drop it when a filter is active (#1308)",
    "see packages/daemon/src/session-domain-roundtrip.spec.ts for what this protects",
  ],
  documentation: "#3039",
  check({ file, violated, checked }) {
    if (!file.relPath.startsWith("packages/daemon/src/")) return;
    if (!file.relPath.endsWith("-session-worker.ts")) return;

    checked();

    const listBody = functionRegion(file.content, "handleSessionList");
    // Not scoped (or no such function) — this worker has not opted into the partition,
    // and the rule has nothing to say about it.
    if (!listBody?.includes(READS_FILTER)) return;

    const waitBody = functionRegion(file.content, "handleWait");
    if (waitBody === null) return;
    if (waitBody.includes(READS_FILTER)) return;

    const lines = file.content.split("\n");
    const idx = lines.findIndex((l) => /^(?:export\s+)?(?:async\s+)?function\s+handleWait\b/.test(l));
    violated(idx + 1, 1, (lines[idx] ?? "handleWait").trim());
  },
};

export default rule;
