import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID, WORK_ITEMS_SERVER_NAME } from "@mcp-cli/core";

import {
  DOMAIN_META_KEY,
  DOMAIN_SCOPED_SERVERS,
  type DomainResolver,
  UNSCOPED_DOMAIN,
  domainScopeFromMeta,
  domainStateRoot,
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
 * Phase state is keyed by `(repo_root, namespace, key)` and the phase runner writes it under
 * the CALLER's git root. A daemon-internal reader substituting its own cwd reads a different
 * key and gets `{}` — no error, an empty store. Same silent-empty shape as the startup-bound
 * work-item readers, and the reason the automation dispatcher's state lookups were wrong.
 */
describe("domainStateRoot", () => {
  const lookup = {
    getDomainById(id: number): Domain | null {
      return id === 1 ? domain(1, "alpha", "/home/u/alpha") : null;
    },
  };

  test("a domained row is keyed under its OWN domain's path, not the daemon's cwd", () => {
    expect(domainStateRoot(lookup, 1, "/daemon/cwd")).toBe("/home/u/alpha");
  });

  test("the unassigned partition falls back to the daemon's cwd — where those rows came from", () => {
    expect(domainStateRoot(lookup, NO_DOMAIN_ID, "/daemon/cwd")).toBe("/daemon/cwd");
  });

  test("an unknown domain id falls back rather than inventing a path", () => {
    expect(domainStateRoot(lookup, 99, "/daemon/cwd")).toBe("/daemon/cwd");
  });
});
