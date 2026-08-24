import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID, WORK_ITEMS_SERVER_NAME } from "@mcp-cli/core";

import {
  DOMAIN_META_KEY,
  DOMAIN_SCOPED_SERVERS,
  type DomainResolver,
  UNSCOPED_DOMAIN,
  domainScopeFromMeta,
  resolveDomainId,
  resolveDomainScope,
} from "./domain-scope";

function domain(id: number, name: string, path: string): Domain {
  return { id, name, host: null, path, createdAt: "2026-08-22T00:00:00.000Z" };
}

/** Stand-in for StateDb: the real one canonicalizes and throws on a relative path. */
function resolver(domains: Domain[]): DomainResolver {
  return {
    resolveDomain(path: string): Domain | null {
      if (!path.startsWith("/")) throw new Error(`domain path must be absolute, got ${JSON.stringify(path)}`);
      let best: Domain | null = null;
      for (const d of domains) {
        if (path === d.path || path.startsWith(`${d.path}/`)) {
          if (!best || d.path.length > best.path.length) best = d;
        }
      }
      return best;
    },
  };
}

describe("resolveDomainScope", () => {
  const domains = [domain(1, "alpha", "/home/u/alpha"), domain(2, "nested", "/home/u/alpha/sub")];

  test("a path inside a domain resolves to it", () => {
    expect(resolveDomainScope(resolver(domains), "/home/u/alpha/src/x.ts")).toEqual({ id: 1, name: "alpha" });
  });

  test("the innermost domain wins when domains nest", () => {
    expect(resolveDomainScope(resolver(domains), "/home/u/alpha/sub/deep")).toEqual({ id: 2, name: "nested" });
  });

  test("a path outside every domain is the unassigned partition, not the nearest guess", () => {
    expect(resolveDomainScope(resolver(domains), "/var/tmp/elsewhere")).toEqual(UNSCOPED_DOMAIN);
  });

  // Each of these reaches this function as "the caller's cwd", where raising would turn a
  // cosmetic input problem into a failed tool call. They must degrade, not throw.
  test.each([
    ["no resolver", null, "/home/u/alpha"],
    ["undefined path", resolver(domains), undefined],
    ["empty path", resolver(domains), ""],
    ["relative path (resolveDomain throws)", resolver(domains), "relative/dir"],
  ])("%s → unassigned", (_label, res, path) => {
    expect(resolveDomainScope(res, path)).toEqual(UNSCOPED_DOMAIN);
  });

  test("the unassigned partition has no name — nothing invents one for domain 0", () => {
    expect(UNSCOPED_DOMAIN.id).toBe(NO_DOMAIN_ID);
    expect(UNSCOPED_DOMAIN.name).toBeNull();
  });

  test("resolveDomainId returns the same id as resolveDomainScope", () => {
    expect(resolveDomainId(resolver(domains), "/home/u/alpha")).toBe(1);
    expect(resolveDomainId(resolver(domains), "/nope")).toBe(NO_DOMAIN_ID);
  });
});

describe("domainScopeFromMeta", () => {
  test("round-trips what the tool handler attaches", () => {
    const scope = { id: 3, name: "phoenix" };
    expect(domainScopeFromMeta({ [DOMAIN_META_KEY]: scope })).toEqual(scope);
  });

  test("a name-less scope is accepted — the id is what partitions", () => {
    expect(domainScopeFromMeta({ [DOMAIN_META_KEY]: { id: 4 } })).toEqual({ id: 4, name: null });
  });

  // Anything unusable must land in the unassigned partition rather than throwing or, worse,
  // being coerced into some other domain's id.
  test.each([
    ["absent _meta", undefined],
    ["null", null],
    ["a string", "phoenix"],
    ["_meta without our key", { other: 1 }],
    ["a non-object value", { [DOMAIN_META_KEY]: 7 }],
    ["a non-numeric id", { [DOMAIN_META_KEY]: { id: "3" } }],
    ["a fractional id", { [DOMAIN_META_KEY]: { id: 1.5 } }],
    ["a negative id", { [DOMAIN_META_KEY]: { id: -1 } }],
  ])("%s → unassigned", (_label, meta) => {
    expect(domainScopeFromMeta(meta)).toEqual(UNSCOPED_DOMAIN);
  });
});

describe("DOMAIN_SCOPED_SERVERS", () => {
  test("_work_items receives the domain", () => {
    expect(DOMAIN_SCOPED_SERVERS.has(WORK_ITEMS_SERVER_NAME)).toBe(true);
  });

  test("a third-party server does not — mcx routing metadata stays inside mcx", () => {
    expect(DOMAIN_SCOPED_SERVERS.has("atlassian")).toBe(false);
  });
});

/**
 * Unresolved scope must fail CLOSED (the #3199 shape).
 *
 * `mcx claude bye --all` ends every session on the machine when run from outside every
 * domain, because `domainCwd` is stripped at the daemon boundary and the worker cannot
 * distinguish "scoping was requested and did not resolve" from "no scoping was requested".
 * The information is destroyed, and the value it collapses to means NO FILTER — so the
 * failure is maximally permissive.
 *
 * This module collapses exactly the same distinction: absent `_meta`, a missing key, and
 * malformed input all yield the same scope. That collapse is fine ONLY because the value it
 * collapses to is `NO_DOMAIN_ID` — one specific, narrow partition — and not "no filter". A
 * caller whose domain fails to resolve therefore sees LESS than it expected, never another
 * domain's rows and never everything.
 *
 * Cross-domain access exists, but only behind an explicitly named method
 * (`WorkItemDb.acrossDomains()`), and is unreachable from a resolution failure. These tests
 * exist so that stays true: if someone later makes the unresolved case mean "all domains",
 * this file fails rather than a machine-wide command shipping.
 */
describe("unresolved scope fails closed, not open (#3199 class)", () => {
  const unresolvable: Array<[string, unknown]> = [
    ["no _meta at all", undefined],
    ["_meta present but our key absent", { other: 1 }],
    ["a domain was requested but is malformed", { [DOMAIN_META_KEY]: { id: "not-a-number" } }],
    ["a domain was requested but the id is negative", { [DOMAIN_META_KEY]: { id: -1 } }],
    ["a domain was requested but the id is fractional", { [DOMAIN_META_KEY]: { id: 1.5 } }],
  ];

  test.each(unresolvable)("%s resolves to the sentinel partition, never a wildcard", (_label, meta) => {
    const scope = domainScopeFromMeta(meta);
    expect(scope.id).toBe(NO_DOMAIN_ID);
    // The assertion that matters: it is a REAL partition id, not a sentinel meaning "any".
    expect(Number.isInteger(scope.id)).toBe(true);
    expect(scope.id).toBeGreaterThanOrEqual(0);
  });

  test("a failed path resolution is also the sentinel, not every domain", () => {
    const alwaysFails: DomainResolver = {
      resolveDomain() {
        throw new Error("domains table unavailable");
      },
    };
    expect(resolveDomainScope(alwaysFails, "/home/u/alpha")).toEqual(UNSCOPED_DOMAIN);
  });

  test("no unresolved input can produce a different domain's id", () => {
    // Whatever a caller sends, it cannot land in domain 1, 2, or 3.
    for (const [, meta] of unresolvable) {
      expect(domainScopeFromMeta(meta).id).not.toBe(1);
      expect(domainScopeFromMeta(meta).id).not.toBe(2);
      expect(domainScopeFromMeta(meta).id).not.toBe(3);
    }
  });
});
