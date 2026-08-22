/**
 * Rule: domain-mutation-invalidates-resolver
 *
 * A file that writes the `domains` table must also invalidate the daemon's
 * `DomainResolver` memo.
 *
 * `createDomainResolver` caches the domain list and every path→id answer, because its
 * hot caller is `EventBus.publish` — the daemon's busiest insert — and re-resolving would
 * cost a `SELECT` plus a `realpath` per event. The cache is only correct while the
 * `domains` table is unchanged. `mcx domain add | rename | rm` (#3035) changes it.
 *
 * The failure this prevents is silent and durable, not loud: after `mcx domain add
 * phoenix ~/phoenix`, a stale resolver keeps answering `NO_DOMAIN_ID` for every path
 * under it, so every event and every `ctx.state` write lands on the sentinel partition.
 * Nothing errors. The rows are simply in the wrong domain, and stay there — `mcx monitor
 * -d phoenix` shows an empty stream and the operator concludes the domain is quiet.
 *
 * This is a rule rather than a sentence in `domain-resolver.ts` for the reason the whole
 * domain epic exists: "any invariant an orchestrator could rationalize past is a
 * function, not prose" (`docs/domain-scoped-mcx.md`). A doc comment saying "remember to
 * call invalidate()" is read once, by the person who wrote it.
 *
 * Scope: production code under `packages/`. Test files are exempt — a spec constructs
 * resolvers over hand-written lists and asserts the staleness directly.
 *
 * Suppression: `// dotw-ignore domain-mutation-invalidates-resolver: <reason>` — e.g. a
 * file that creates domains before any resolver exists (the one-shot import).
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

/** StateDb methods that write the `domains` table. */
const MUTATORS = new Set(["createDomain", "renameDomain", "deleteDomain"]);

/** What counts as clearing the memo. */
const INVALIDATORS = new Set(["invalidate"]);

/**
 * The resolver itself and the `db/` layer are where these methods are *defined*; the
 * rule is about *callers* elsewhere in the daemon.
 */
function isExempt(relPath: string): boolean {
  return (
    relPath.startsWith("packages/daemon/src/db/") ||
    relPath === "packages/daemon/src/domain-resolver.ts" ||
    relPath.startsWith("packages/core/src/domain")
  );
}

const rule: CheckRule = {
  id: "domain-mutation-invalidates-resolver",
  kind: "check",
  appliesToTests: false,
  scold:
    "writes the domains table without invalidating the DomainResolver memo — every later lookup answers from a stale cache",
  guidance: [
    "call `<resolver>.invalidate()` after createDomain / renameDomain / deleteDomain",
    "the daemon builds one resolver in index.ts and shares it with the EventBus and the IPC server — invalidate that one",
    "a stale resolver does not error: it silently stamps NO_DOMAIN_ID on every event and every ctx.state write",
    "if this file genuinely runs before any resolver exists, add: // dotw-ignore domain-mutation-invalidates-resolver: <reason>",
  ],
  documentation: "#3040",
  check({ file, violated, checked, ast }) {
    if (!file.relPath.startsWith("packages/")) return;
    if (isExempt(file.relPath)) return;
    checked();

    const calls = ast.find(ts.isCallExpression);
    const mutations: ts.CallExpression[] = [];
    let invalidates = false;

    for (const call of calls) {
      if (!ts.isPropertyAccessExpression(call.expression)) continue;
      const name = call.expression.name.text;
      if (MUTATORS.has(name)) mutations.push(call);
      if (INVALIDATORS.has(name)) invalidates = true;
    }

    if (mutations.length === 0 || invalidates) return;

    for (const call of mutations) {
      const { line, column } = ast.positionOf(call);
      violated(line, column, call.getText(ast.sourceFile).split("\n")[0] ?? "");
    }
  },
};

export default rule;
