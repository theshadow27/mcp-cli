import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import { FALLBACK_ROOT_NAME, domainRootIndex, resolveDomainRoots } from "./domain-roots";

function domain(over: Partial<Domain> & { id: number; name: string; path: string }): Domain {
  return { host: null, createdAt: "2026-01-01T00:00:00Z", ...over };
}

describe("resolveDomainRoots", () => {
  test("returns one root per registered local domain, in id order", () => {
    const roots = resolveDomainRoots({
      domains: [domain({ id: 2, name: "phoenix", path: "/tmp" }), domain({ id: 1, name: "mcp-cli", path: "/usr" })],
      fallbackRoot: "/etc",
    });

    expect(roots.map((r) => [r.id, r.name, r.path])).toEqual([
      [1, "mcp-cli", "/usr"],
      [2, "phoenix", "/tmp"],
    ]);
    expect(roots.every((r) => r.fallback)).toBe(false);
  });

  test("the cwd fallback is used ONLY when no local domain is registered", () => {
    // The whole point of #3192: a registered domain is a better answer than the directory
    // that happened to start mcpd, so the cwd must not be added alongside one.
    const withDomain = resolveDomainRoots({
      domains: [domain({ id: 1, name: "mcp-cli", path: "/usr" })],
      fallbackRoot: "/etc",
    });
    expect(withDomain.map((r) => r.path)).toEqual(["/usr"]);

    const bare = resolveDomainRoots({ domains: [], fallbackRoot: "/etc" });
    expect(bare).toEqual([{ id: NO_DOMAIN_ID, name: FALLBACK_ROOT_NAME, path: "/etc", fallback: true }]);
  });

  test("no domains and no fallback yields no roots at all", () => {
    expect(resolveDomainRoots({ domains: [], fallbackRoot: null })).toEqual([]);
    expect(resolveDomainRoots({ domains: [] })).toEqual([]);
  });

  test("remote domains are excluded — another host's daemon serves those", () => {
    const roots = resolveDomainRoots({
      domains: [
        domain({ id: 1, name: "remote", path: "/usr", host: "sprite" }),
        domain({ id: 2, name: "local", path: "/tmp" }),
      ],
      fallbackRoot: null,
    });
    expect(roots.map((r) => r.name)).toEqual(["local"]);
  });

  test("a box whose only domains are remote falls back rather than running nothing", () => {
    const roots = resolveDomainRoots({
      domains: [domain({ id: 1, name: "remote", path: "/usr", host: "sprite" })],
      fallbackRoot: "/etc",
    });
    expect(roots.map((r) => [r.name, r.fallback])).toEqual([[FALLBACK_ROOT_NAME, true]]);
  });

  test("two names bound to one directory collapse to one root, lowest id winning", () => {
    // Nothing stops `mcx domain add` registering the same path twice. Two dispatchers over
    // one manifest would fire every module twice.
    const roots = resolveDomainRoots({
      domains: [domain({ id: 3, name: "alias", path: "/tmp" }), domain({ id: 1, name: "canonical", path: "/tmp" })],
      fallbackRoot: null,
    });
    expect(roots.map((r) => [r.id, r.name])).toEqual([[1, "canonical"]]);
  });
});

describe("domainRootIndex", () => {
  test("indexes by domain id", () => {
    const roots = resolveDomainRoots({
      domains: [domain({ id: 7, name: "seven", path: "/tmp" })],
      fallbackRoot: null,
    });
    expect(domainRootIndex(roots).get(7)?.name).toBe("seven");
    expect(domainRootIndex(roots).get(8)).toBeUndefined();
  });
});
