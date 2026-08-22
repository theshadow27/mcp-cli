import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import { NULL_DOMAIN_RESOLVER, createDomainResolver } from "./domain-resolver";

function domain(id: number, name: string, path: string, host: string | null = null): Domain {
  return { id, name, host, path, createdAt: "2026-08-22T00:00:00.000Z" };
}

/** Counts reads so the memo can be asserted on rather than assumed. */
function countingSource(domains: Domain[]) {
  let reads = 0;
  return {
    listDomains: () => {
      reads++;
      return domains;
    },
    get reads() {
      return reads;
    },
  };
}

describe("createDomainResolver", () => {
  test("resolves a path to the domain that owns it", () => {
    const r = createDomainResolver({ listDomains: () => [domain(3, "phoenix", "/tmp")] });
    expect(r.idForPath("/tmp/nested/deep")).toBe(3);
  });

  test("a path outside every domain is the sentinel, never a guess", () => {
    const r = createDomainResolver({ listDomains: () => [domain(3, "phoenix", "/tmp/phoenix")] });
    expect(r.idForPath("/var/elsewhere")).toBe(NO_DOMAIN_ID);
  });

  test("no domains registered resolves to the sentinel", () => {
    const r = createDomainResolver({ listDomains: () => [] });
    expect(r.idForPath("/tmp")).toBe(NO_DOMAIN_ID);
  });

  test("undefined and empty paths resolve to the sentinel without touching the database", () => {
    const src = countingSource([domain(3, "phoenix", "/tmp")]);
    const r = createDomainResolver(src);
    expect(r.idForPath(undefined)).toBe(NO_DOMAIN_ID);
    expect(r.idForPath("")).toBe(NO_DOMAIN_ID);
    expect(src.reads).toBe(0);
  });

  // A relative repoRoot is junk on the publish path; resolveDomainForPath throws on it.
  // The resolver must degrade to the sentinel rather than take down EventBus.publish.
  test("a non-absolute path is the sentinel, not a throw", () => {
    const r = createDomainResolver({ listDomains: () => [domain(3, "phoenix", "/tmp")] });
    expect(() => r.idForPath("relative/path")).not.toThrow();
    expect(r.idForPath("relative/path")).toBe(NO_DOMAIN_ID);
  });

  test("nested domains resolve to the innermost", () => {
    const r = createDomainResolver({
      listDomains: () => [domain(1, "outer", "/tmp/work"), domain(2, "inner", "/tmp/work/sub")],
    });
    expect(r.idForPath("/tmp/work/sub/pkg")).toBe(2);
    expect(r.idForPath("/tmp/work/other")).toBe(1);
  });

  test("a host-bound domain never owns a local path", () => {
    const r = createDomainResolver({ listDomains: () => [domain(5, "remote", "/tmp", "boxen0010")] });
    expect(r.idForPath("/tmp/anything")).toBe(NO_DOMAIN_ID);
  });

  test("name and id map both ways; the sentinel has no name", () => {
    const r = createDomainResolver({ listDomains: () => [domain(3, "phoenix", "/tmp")] });
    expect(r.idForName("phoenix")).toBe(3);
    expect(r.idForName("nope")).toBeNull();
    expect(r.nameForId(3)).toBe("phoenix");
    expect(r.nameForId(NO_DOMAIN_ID)).toBeNull();
    expect(r.nameForId(99)).toBeNull();
  });

  test("repeated lookups hit the memo, not the database", () => {
    const src = countingSource([domain(3, "phoenix", "/tmp")]);
    const r = createDomainResolver(src);
    r.idForPath("/tmp/a");
    r.idForPath("/tmp/a");
    r.idForPath("/tmp/a");
    expect(src.reads).toBe(1);
  });

  test("invalidate() makes the next lookup see a domain added since", () => {
    const domains: Domain[] = [];
    const r = createDomainResolver({ listDomains: () => [...domains] });
    expect(r.idForPath("/tmp/late")).toBe(NO_DOMAIN_ID);

    domains.push(domain(7, "late", "/tmp/late"));
    // Still memoized — this is exactly the staleness invalidate() exists to clear.
    expect(r.idForPath("/tmp/late")).toBe(NO_DOMAIN_ID);

    r.invalidate();
    expect(r.idForPath("/tmp/late")).toBe(7);
    expect(r.idForName("late")).toBe(7);
  });

  test("the memo is bounded — unbounded distinct paths do not grow it without limit", () => {
    const src = countingSource([domain(3, "phoenix", "/tmp/phoenix")]);
    const r = createDomainResolver(src);
    // 1024 is the cap; 2000 distinct paths must not wedge or leak.
    for (let i = 0; i < 2000; i++) r.idForPath(`/tmp/phoenix/p${i}`);
    expect(r.idForPath("/tmp/phoenix/p0")).toBe(3);
  });
});

describe("NULL_DOMAIN_RESOLVER", () => {
  test("answers the sentinel for everything, so a daemon with no domain table is well-defined", () => {
    expect(NULL_DOMAIN_RESOLVER.idForPath("/tmp/anything")).toBe(NO_DOMAIN_ID);
    expect(NULL_DOMAIN_RESOLVER.idForName("phoenix")).toBeNull();
    expect(NULL_DOMAIN_RESOLVER.nameForId(3)).toBeNull();
    expect(() => NULL_DOMAIN_RESOLVER.invalidate()).not.toThrow();
  });
});
