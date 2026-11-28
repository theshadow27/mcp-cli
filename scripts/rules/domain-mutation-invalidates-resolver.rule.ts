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
 * Suppression: `// doing-it-wrong-ignore domain-mutation-invalidates-resolver: <reason> (#issue)` — e.g. a
 * file that creates domains before any resolver exists (the one-shot import).
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

type Node = TSESTree.Node;

/** McxDb methods that write the `domains` table. */
const MUTATORS = new Set(["createDomain", "renameDomain", "deleteDomain"]);

/** What counts as clearing the memo. */
const INVALIDATORS = new Set(["invalidate"]);

/**
 * Identifiers a domain resolver is actually bound to in this codebase.
 *
 * Matched as a WHOLE final segment, not a substring. A substring test was the residual
 * bypass the delta review drove: `domainNameCache.invalidate()` and
 * `pathResolverCache.invalidate()` both contain the substring and both silenced the rule.
 * `x.y.domains.invalidate()` is accepted via the final segment; `domainNameCache` is not.
 */
const RESOLVER_NAMES = new Set(["domains", "domainresolver", "resolver"]);

/**
 * Does this receiver name a domain resolver?
 *
 * A file-wide "someone called .invalidate() somewhere" is not a check: it silenced the
 * rule on the exact input it exists to catch (#3040 review R5): `db.createDomain(a, b)`
 * next to an unrelated `someCache.invalidate()` reported clean.
 *
 * Deliberately errs toward FLAGGING: an unrecognised receiver means the rule reports and
 * a human either renames or suppresses.
 */
function isResolverReceiver(expr: Node, content: string): boolean {
  const last =
    expr.type === "MemberExpression" && !expr.computed && expr.property.type === "Identifier"
      ? expr.property.name
      : content.slice(...expr.range);
  return RESOLVER_NAMES.has(last.toLowerCase());
}

/** The method name a call invokes, whether `db.createDomain(…)` or a destructured `createDomain(…)`. */
function calleeName(call: TSESTree.CallExpression): string | null {
  const callee = call.callee;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  // Destructuring is the other residual bypass the delta review drove:
  // `const { createDomain } = db; createDomain(a, b)` matched nothing at all.
  if (callee.type === "Identifier") return callee.name;
  return null;
}

/**
 * The function enclosing `node`, or the Program for a top-level statement.
 *
 * Used so an `invalidate()` in a *different* function does not count as covering a
 * mutation over here: "somewhere in this file" is not the same claim as "on this path".
 */
function enclosingScope(node: Node): Node {
  let cur: Node | undefined = node.parent;
  while (cur) {
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression" ||
      cur.type === "Program"
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node;
}

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

export default {
  id: "domain-mutation-invalidates-resolver",
  type: "check",
  category: "architecture",
  ast: true,
  tests: "exclude",
  scold:
    "writes the domains table without invalidating the DomainResolver memo — every later lookup answers from a stale cache",
  guidance: [
    "call `<resolver>.invalidate()` after createDomain / renameDomain / deleteDomain",
    "the daemon builds one resolver in index.ts and shares it with the EventBus and the IPC server — invalidate that one",
    "a stale resolver does not error: it silently stamps NO_DOMAIN_ID on every event and every ctx.state write",
    "if this file genuinely runs before any resolver exists, add: // doing-it-wrong-ignore domain-mutation-invalidates-resolver: <reason> (#issue)",
  ],
  documentation: "#3040",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/")) return ctx.skipped();
    if (isExempt(file.relativePath)) return ctx.skipped();

    const mutations: TSESTree.CallExpression[] = [];
    const invalidations: TSESTree.CallExpression[] = [];

    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression") return;
      const name = calleeName(node);
      if (name === null) return;
      if (MUTATORS.has(name)) {
        mutations.push(node);
      } else if (
        INVALIDATORS.has(name) &&
        node.callee.type === "MemberExpression" &&
        isResolverReceiver(node.callee.object, file.content)
      ) {
        invalidations.push(node);
      }
    });

    for (const mutation of mutations) {
      const scope = enclosingScope(mutation);
      // Must be a resolver-looking receiver, in the same function, AFTER the mutation.
      // Ordering matters: invalidating and then mutating leaves the memo just as stale.
      const covered = invalidations.some((inv) => enclosingScope(inv) === scope && inv.range[0] > mutation.range[0]);
      if (covered) continue;

      ctx.violated(
        mutation.loc.start.line,
        mutation.loc.start.column + 1,
        file.content.slice(...mutation.range).split("\n")[0] ?? "",
      );
    }
    return ctx.checked();
  },
} satisfies Rule;
