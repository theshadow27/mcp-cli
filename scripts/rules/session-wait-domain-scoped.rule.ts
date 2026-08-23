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

/** Source text of a top-level `interface <name> { … }`, by brace matching from its `{`. */
function interfaceRegion(source: string, name: string): string | null {
  const decl = new RegExp(`interface\\s+${name}\\b`).exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

const rule: CheckRule = {
  id: "session-wait-domain-scoped",
  kind: "check",
  scold:
    "this worker scopes handleSessionList but does not honour the partition in handleWait — a scoped wait will wake on another domain's session, or lose its own after one ends",
  guidance: [
    "read the daemon-injected filter in handleWait: `const domainId = domainFilterArg(args);`",
    "filter the any-session set, the buffered afterSeq replay, and the timeout fallback list",
    "carry the domain ON the BufferedEvent, captured at buffer time — the buffer outlives the live sessions map",
    "an event whose session is gone cannot be attributed from that map; that is why the record must carry it",
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

    const lines = file.content.split("\n");
    const waitBody = functionRegion(file.content, "handleWait");
    if (waitBody === null) return;

    if (!waitBody.includes(READS_FILTER)) {
      const idx = lines.findIndex((l) => /^(?:export\s+)?(?:async\s+)?function\s+handleWait\b/.test(l));
      violated(idx + 1, 1, (lines[idx] ?? "handleWait").trim());
      return;
    }

    // Second half of the invariant. Reading the filter is not honouring it: a worker
    // with an event buffer must also carry the domain ON the buffered record. The
    // first version of this rule checked only that the identifier appeared, and every
    // worker passed while all four lost a scoped `wait --after` its own events the
    // moment a session ended — the buffer outlives the live `sessions` map, so a
    // domain re-derived from that map at read time is gone exactly when it is needed.
    if (!file.content.includes("interface BufferedEvent")) return;
    const buffered = interfaceRegion(file.content, "BufferedEvent");
    if (buffered !== null && !/\bdomainId\b/.test(buffered)) {
      const idx = lines.findIndex((l) => /interface\s+BufferedEvent\b/.test(l));
      violated(idx + 1, 1, (lines[idx] ?? "interface BufferedEvent").trim());
    }
  },
};

export default rule;
