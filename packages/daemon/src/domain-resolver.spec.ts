import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import { NULL_DOMAIN_RESOLVER, createDomainResolver } from "./domain-resolver";

/*
 * Fixture paths use `/mcx-test/...`, a root that exists on no platform, rather than
 * `/tmp` or `/home`. These tests never touch the filesystem, but the code under test
 * canonicalizes the paths it is handed — and on macOS `/tmp` and `/var` are symlinks and
 * `/home` is a firmlink, so a query built on one of those resolves (`/private/tmp/...`)
 * while the hand-built domain row beside it does not. That asymmetry is an artifact of
 * the fixture, not of the rule being tested: production stores domain paths canonical.
 * A root that resolves to itself everywhere keeps both sides in the same spelling.
 */

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
    getSessionPaths: () => [],
    get reads() {
      return reads;
    },
  };
}

/**
 * A source with domains but NO session lookup, stated explicitly.
 *
 * `getSessionPath` is required on `DomainSource` precisely so this is a decision a test
 * writes down rather than an omission the compiler tolerates — see the interface doc.
 */
function noSessions(domains: Domain[]) {
  return { listDomains: () => domains, getSessionPaths: () => [] };
}

describe("createDomainResolver", () => {
  test("resolves a path to the domain that owns it", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test")]));
    expect(r.idForPath("/mcx-test/nested/deep")).toBe(3);
  });

  test("a path outside every domain is the sentinel, never a guess", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test/phoenix")]));
    expect(r.idForPath("/mcx-elsewhere/elsewhere")).toBe(NO_DOMAIN_ID);
  });

  test("no domains registered resolves to the sentinel", () => {
    const r = createDomainResolver(noSessions([]));
    expect(r.idForPath("/mcx-test")).toBe(NO_DOMAIN_ID);
  });

  test("undefined and empty paths resolve to the sentinel without touching the database", () => {
    const src = countingSource([domain(3, "phoenix", "/mcx-test")]);
    const r = createDomainResolver(src);
    expect(r.idForPath(undefined)).toBe(NO_DOMAIN_ID);
    expect(r.idForPath("")).toBe(NO_DOMAIN_ID);
    expect(src.reads).toBe(0);
  });

  // A relative repoRoot is junk on the publish path; resolveDomainForPath throws on it.
  // The resolver must degrade to the sentinel rather than take down EventBus.publish.
  test("a non-absolute path is the sentinel, not a throw", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test")]));
    expect(() => r.idForPath("relative/path")).not.toThrow();
    expect(r.idForPath("relative/path")).toBe(NO_DOMAIN_ID);
  });

  test("nested domains resolve to the innermost", () => {
    const r = createDomainResolver({
      listDomains: () => [domain(1, "outer", "/mcx-test/work"), domain(2, "inner", "/mcx-test/work/sub")],
      getSessionPaths: () => [],
    });
    expect(r.idForPath("/mcx-test/work/sub/pkg")).toBe(2);
    expect(r.idForPath("/mcx-test/work/other")).toBe(1);
  });

  test("a host-bound domain never owns a local path", () => {
    const r = createDomainResolver(noSessions([domain(5, "remote", "/mcx-test", "boxen0010")]));
    expect(r.idForPath("/mcx-test/anything")).toBe(NO_DOMAIN_ID);
  });

  test("name and id map both ways; the sentinel has no name", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test")]));
    expect(r.idForName("phoenix")).toBe(3);
    expect(r.idForName("nope")).toBeNull();
    expect(r.nameForId(3)).toBe("phoenix");
    expect(r.nameForId(NO_DOMAIN_ID)).toBeNull();
    expect(r.nameForId(99)).toBeNull();
  });

  test("repeated lookups hit the memo, not the database", () => {
    const src = countingSource([domain(3, "phoenix", "/mcx-test")]);
    const r = createDomainResolver(src);
    r.idForPath("/mcx-test/a");
    r.idForPath("/mcx-test/a");
    r.idForPath("/mcx-test/a");
    expect(src.reads).toBe(1);
  });

  test("invalidate() makes the next lookup see a domain added since", () => {
    const domains: Domain[] = [];
    // Lazy on purpose: the source must be re-read after invalidate(), so this cannot
    // use the snapshot helper.
    const r = createDomainResolver({ listDomains: () => [...domains], getSessionPaths: () => [] });
    expect(r.idForPath("/mcx-test/late")).toBe(NO_DOMAIN_ID);

    domains.push(domain(7, "late", "/mcx-test/late"));
    // Still memoized — this is exactly the staleness invalidate() exists to clear.
    expect(r.idForPath("/mcx-test/late")).toBe(NO_DOMAIN_ID);

    r.invalidate();
    expect(r.idForPath("/mcx-test/late")).toBe(7);
    expect(r.idForName("late")).toBe(7);
  });

  // The previous version of this test looped 2000 paths and then asserted
  // idForPath(...) === 3, which passes identically with the cap deleted, set to 1, or
  // the memo removed entirely — it asserted the conclusion, not the premise
  // (#3040 review R6). These drive the bound and observe it.
  test("the memo never exceeds the configured cap", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test/phoenix")]), { maxMemoized: 4 });
    for (let i = 0; i < 40; i++) {
      r.idForPath(`/mcx-test/phoenix/p${i}`);
      expect(r.memoSize()).toBeLessThanOrEqual(4);
    }
  });

  test("the memo actually grows before it is cleared — the cap is doing something", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test/phoenix")]), { maxMemoized: 4 });
    expect(r.memoSize()).toBe(0);
    r.idForPath("/mcx-test/phoenix/a");
    r.idForPath("/mcx-test/phoenix/b");
    expect(r.memoSize()).toBe(2);
    r.idForPath("/mcx-test/phoenix/c");
    r.idForPath("/mcx-test/phoenix/d");
    expect(r.memoSize()).toBe(4);
    // Fifth distinct path trips the cap: cleared, then the new entry recorded.
    r.idForPath("/mcx-test/phoenix/e");
    expect(r.memoSize()).toBe(1);
  });

  test("answers stay correct across an overflow clear", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test/phoenix")]), { maxMemoized: 2 });
    for (let i = 0; i < 20; i++) r.idForPath(`/mcx-test/phoenix/p${i}`);
    expect(r.idForPath("/mcx-test/phoenix/p0")).toBe(3);
    expect(r.idForPath("/mcx-elsewhere/outside")).toBe(NO_DOMAIN_ID);
  });

  test("invalidate() empties the memo observably", () => {
    const r = createDomainResolver(noSessions([domain(3, "phoenix", "/mcx-test/phoenix")]));
    r.idForPath("/mcx-test/phoenix/a");
    expect(r.memoSize()).toBeGreaterThan(0);
    r.invalidate();
    expect(r.memoSize()).toBe(0);
  });
});

describe("createDomainResolver — session identity (#3040 review R3)", () => {
  const DOMAINS = [domain(3, "phoenix", "/mcx-test/phoenix"), domain(7, "clrg", "/mcx-test/clrg")];

  function withSessions(sessions: Record<string, string | null>) {
    let lookups = 0;
    return {
      listDomains: () => DOMAINS,
      getSessionPaths: (id: string) => {
        lookups++;
        const root = sessions[id];
        return typeof root === "string" && root !== "" ? [root] : [];
      },
      get lookups() {
        return lookups;
      },
    };
  }

  test("resolves a session to the domain of the root that session recorded", () => {
    const r = createDomainResolver(withSessions({ s1: "/mcx-test/phoenix/pkg", s2: "/mcx-test/clrg" }));
    expect(r.idForSession("s1")).toBe(3);
    expect(r.idForSession("s2")).toBe(7);
  });

  test("an unknown or rootless session is the sentinel, not a guess", () => {
    const r = createDomainResolver(withSessions({ s1: null }));
    expect(r.idForSession("s1")).toBe(NO_DOMAIN_ID);
    expect(r.idForSession("never-seen")).toBe(NO_DOMAIN_ID);
    expect(r.idForSession(undefined)).toBe(NO_DOMAIN_ID);
    expect(r.idForSession("")).toBe(NO_DOMAIN_ID);
  });

  test("a session whose root is outside every domain is the sentinel", () => {
    const r = createDomainResolver(withSessions({ s1: "/mcx-elsewhere/elsewhere" }));
    expect(r.idForSession("s1")).toBe(NO_DOMAIN_ID);
  });

  test("session lookups are memoized — one DB read per session, not per event", () => {
    const src = withSessions({ s1: "/mcx-test/phoenix" });
    const r = createDomainResolver(src);
    for (let i = 0; i < 25; i++) r.idForSession("s1");
    expect(src.lookups).toBe(1);
  });

  test("a source with no session lookup degrades to the sentinel rather than throwing", () => {
    const r = createDomainResolver(noSessions(DOMAINS));
    expect(() => r.idForSession("s1")).not.toThrow();
    expect(r.idForSession("s1")).toBe(NO_DOMAIN_ID);
  });

  test("invalidate() clears session memo too", () => {
    const sessions: Record<string, string | null> = { s1: null };
    const r = createDomainResolver({
      listDomains: () => DOMAINS,
      getSessionPaths: (id: string) => {
        const root = sessions[id];
        return typeof root === "string" && root !== "" ? [root] : [];
      },
    });
    expect(r.idForSession("s1")).toBe(NO_DOMAIN_ID);
    sessions.s1 = "/mcx-test/phoenix";
    expect(r.idForSession("s1")).toBe(NO_DOMAIN_ID); // memoized
    r.invalidate();
    expect(r.idForSession("s1")).toBe(3);
  });
});

describe("NULL_DOMAIN_RESOLVER", () => {
  test("answers the sentinel for everything, so a daemon with no domain table is well-defined", () => {
    expect(NULL_DOMAIN_RESOLVER.idForPath("/mcx-test/anything")).toBe(NO_DOMAIN_ID);
    expect(NULL_DOMAIN_RESOLVER.idForSession("s1")).toBe(NO_DOMAIN_ID);
    expect(NULL_DOMAIN_RESOLVER.memoSize()).toBe(0);
    expect(NULL_DOMAIN_RESOLVER.idForName("phoenix")).toBeNull();
    expect(NULL_DOMAIN_RESOLVER.nameForId(3)).toBeNull();
    expect(() => NULL_DOMAIN_RESOLVER.invalidate()).not.toThrow();
  });
});
