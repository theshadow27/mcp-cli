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

import ts from "typescript-5";
import type { CheckRule } from "./_engine/rule";

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
 * A file-wide "someone called .invalidate() somewhere" is not a check — it silenced the
 * rule on the exact input it exists to catch (#3040 review R5): `db.createDomain(a, b)`
 * next to an unrelated `someCache.invalidate()` reported clean.
 *
 * Deliberately errs toward FLAGGING: an unrecognised receiver means the rule reports and
 * a human either renames or suppresses. The opposite bias — accepting anything that looks
 * vaguely related — is how this rule shipped passing on its own target input.
 */
function isResolverReceiver(expr: ts.Expression, sf: ts.SourceFile): boolean {
  const last = ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText(sf);
  return RESOLVER_NAMES.has(last.toLowerCase());
}

/** The method name a call invokes, whether `db.createDomain(…)` or a destructured `createDomain(…)`. */
function calleeName(call: ts.CallExpression): string | null {
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  // Destructuring is the other residual bypass the delta review drove:
  // `const { createDomain } = db; createDomain(a, b)` matched nothing at all.
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return null;
}

/**
 * The function body enclosing `node`, or the SourceFile for a top-level statement.
 *
 * Used so an `invalidate()` in a *different* function does not count as covering a
 * mutation over here — "somewhere in this file" is not the same claim as "on this path".
 */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
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

    const sf = ast.sourceFile;
    const mutations: ts.CallExpression[] = [];
    const invalidations: ts.CallExpression[] = [];

    for (const call of ast.find(ts.isCallExpression)) {
      const name = calleeName(call);
      if (name === null) continue;
      if (MUTATORS.has(name)) {
        mutations.push(call);
      } else if (
        INVALIDATORS.has(name) &&
        ts.isPropertyAccessExpression(call.expression) &&
        isResolverReceiver(call.expression.expression, sf)
      ) {
        invalidations.push(call);
      }
    }

    if (mutations.length === 0) return;

    for (const mutation of mutations) {
      const scope = enclosingScope(mutation);
      // Must be a resolver-looking receiver, in the same function, AFTER the mutation.
      // Ordering matters: invalidating and then mutating leaves the memo just as stale.
      const covered = invalidations.some(
        (inv) => enclosingScope(inv) === scope && inv.getStart(sf) > mutation.getStart(sf),
      );
      if (covered) continue;

      const { line, column } = ast.positionOf(mutation);
      violated(line, column, mutation.getText(sf).split("\n")[0] ?? "");
    }
  },
};

export default rule;
