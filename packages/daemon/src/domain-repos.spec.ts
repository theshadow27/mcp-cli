import { describe, expect, test } from "bun:test";
import { DomainRepoResolver, groupByDomain, repoDetectBackoffMs, skippedDomainsError } from "./domain-repos";
import type { RepoInfo } from "./github/graphql-client";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

describe("DomainRepoResolver", () => {
  test("resolves each domain from its own root — the defect #3192 names", async () => {
    const roots = new Map([
      [1, "/projects/alpha"],
      [2, "/projects/beta"],
    ]);
    const seen: string[] = [];
    const resolver = new DomainRepoResolver({
      rootFor: (id) => roots.get(id) ?? null,
      detectRepo: async (cwd) => {
        seen.push(cwd ?? "(none)");
        return { owner: "acme", repo: cwd === "/projects/alpha" ? "alpha" : "beta" };
      },
      logger: SILENT_LOGGER,
    });

    expect(await resolver.repoFor(1)).toEqual({ owner: "acme", repo: "alpha" });
    expect(await resolver.repoFor(2)).toEqual({ owner: "acme", repo: "beta" });
    expect(seen).toEqual(["/projects/alpha", "/projects/beta"]);
  });

  test("caches per domain — a second lookup does not re-run git", async () => {
    let calls = 0;
    const resolver = new DomainRepoResolver({
      rootFor: () => "/projects/alpha",
      detectRepo: async () => {
        calls++;
        return { owner: "a", repo: "b" };
      },
      logger: SILENT_LOGGER,
    });

    await resolver.repoFor(1);
    await resolver.repoFor(1);
    expect(calls).toBe(1);
    expect(resolver.cached(1)).toEqual({ owner: "a", repo: "b" });
    expect(resolver.cached(2)).toBeNull();
  });

  test("concurrent lookups for one domain share a single detection", async () => {
    let calls = 0;
    const resolver = new DomainRepoResolver({
      rootFor: () => "/projects/alpha",
      detectRepo: async () => {
        calls++;
        await Promise.resolve();
        return { owner: "a", repo: "b" };
      },
      logger: SILENT_LOGGER,
    });

    const [first, second] = await Promise.all([resolver.repoFor(1), resolver.repoFor(1)]);
    expect(calls).toBe(1);
    expect(first).toEqual(second as RepoInfo);
  });

  test("falls back to `fallbackRoot` for a domain with no root of its own", async () => {
    let seen: string | undefined;
    const resolver = new DomainRepoResolver({
      rootFor: () => null,
      detectRepo: async (cwd) => {
        seen = cwd;
        return { owner: "a", repo: "b" };
      },
      fallbackRoot: "/fallback",
      logger: SILENT_LOGGER,
    });

    await resolver.repoFor(0);
    expect(seen).toBe("/fallback");
  });

  test("failure backs off per domain, and never gives up permanently (#3243)", async () => {
    let now = 0;
    let attempts = 0;
    const resolver = new DomainRepoResolver({
      rootFor: () => "/projects/alpha",
      detectRepo: async () => {
        attempts++;
        throw new Error("no git remote");
      },
      logger: SILENT_LOGGER,
      now: () => now,
    });

    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(1);
    expect(resolver.lastErrorFor(1)).toBe("no git remote");

    // Inside the window: skipped, no new subprocess.
    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(1);

    now += repoDetectBackoffMs(1);
    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(2);

    // Second failure doubles the window rather than repeating the first one.
    now += repoDetectBackoffMs(1);
    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(2);
    now += repoDetectBackoffMs(2) - repoDetectBackoffMs(1);
    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(3);
  });

  test("one domain's backoff does not stall another's detection", async () => {
    const resolver = new DomainRepoResolver({
      rootFor: (id) => `/projects/${id}`,
      detectRepo: async (cwd) => {
        if (cwd === "/projects/1") throw new Error("no git remote");
        return { owner: "a", repo: "two" };
      },
      logger: SILENT_LOGGER,
      now: () => 0,
    });

    expect(await resolver.repoFor(1)).toBeNull();
    expect(await resolver.repoFor(2)).toEqual({ owner: "a", repo: "two" });
  });

  test("one domain's success does not clear another's error (#3397 review)", async () => {
    // With a single `_lastError` scalar, domain 2 resolving wiped the reason domain 1 was
    // still failing with — and the poller then attached null, or the wrong project's
    // message, to the domain it had just skipped.
    const resolver = new DomainRepoResolver({
      rootFor: (id) => `/projects/${id}`,
      detectRepo: async (cwd) => {
        if (cwd === "/projects/1") throw new Error("no git remote");
        return { owner: "a", repo: "two" };
      },
      logger: SILENT_LOGGER,
      now: () => 0,
    });

    await resolver.repoFor(1);
    await resolver.repoFor(2);

    expect(resolver.lastErrorFor(1)).toBe("no git remote");
    expect(resolver.lastErrorFor(2)).toBeNull();
  });

  test("a domain skipped by backoff still reports why it was skipped", async () => {
    // The backoff arm of `repoFor` returns null without attempting detection, so the reason
    // has to survive from the failure that opened the window.
    let attempts = 0;
    const resolver = new DomainRepoResolver({
      rootFor: () => "/projects/alpha",
      detectRepo: async () => {
        attempts++;
        throw new Error("no git remote");
      },
      logger: SILENT_LOGGER,
      now: () => 0,
    });

    await resolver.repoFor(1);
    expect(await resolver.repoFor(1)).toBeNull();
    expect(attempts).toBe(1); // the second call never attempted — pure backoff
    expect(resolver.lastErrorFor(1)).toBe("no git remote");
  });

  test("recovery clears the error and stops retrying", async () => {
    let now = 0;
    let failing = true;
    const resolver = new DomainRepoResolver({
      rootFor: () => "/projects/alpha",
      detectRepo: async () => {
        if (failing) throw new Error("no git remote");
        return { owner: "a", repo: "b" };
      },
      logger: SILENT_LOGGER,
      now: () => now,
    });

    expect(await resolver.repoFor(1)).toBeNull();
    failing = false;
    now += repoDetectBackoffMs(1);
    expect(await resolver.repoFor(1)).toEqual({ owner: "a", repo: "b" });
    expect(resolver.lastErrorFor(1)).toBeNull();
  });
});

describe("skippedDomainsError", () => {
  const repos = { lastErrorFor: (id: number) => (id === 9 ? null : `domain ${id} broke`) };

  test("no skipped domains is no error", () => {
    expect(skippedDomainsError(repos, [])).toBeNull();
  });

  test("one skipped domain reports its bare reason — the single-project message", () => {
    expect(skippedDomainsError(repos, [1])).toBe("domain 1 broke");
  });

  test("several are labelled, because a bare reason does not say whose repo", () => {
    expect(skippedDomainsError(repos, [1, 2])).toBe("domain 1: domain 1 broke; domain 2: domain 2 broke");
  });

  test("a domain that never attempted detection still owes a reason", () => {
    expect(skippedDomainsError(repos, [9])).toBe("repo not resolved");
  });
});

describe("repoDetectBackoffMs", () => {
  test("doubles from 30s and caps at 15m", () => {
    expect(repoDetectBackoffMs(1)).toBe(30_000);
    expect(repoDetectBackoffMs(2)).toBe(60_000);
    expect(repoDetectBackoffMs(3)).toBe(120_000);
    expect(repoDetectBackoffMs(10)).toBe(15 * 60_000);
    expect(repoDetectBackoffMs(1000)).toBe(15 * 60_000);
  });
});

describe("groupByDomain", () => {
  test("groups rows by domain, preserving encounter order", () => {
    const groups = groupByDomain([
      { domainId: 2, id: "a" },
      { domainId: 1, id: "b" },
      { domainId: 2, id: "c" },
    ]);
    expect([...groups.keys()]).toEqual([2, 1]);
    expect(groups.get(2)?.map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups.get(1)?.map((r) => r.id)).toEqual(["b"]);
  });

  test("no rows means no groups — and therefore no repo detection", () => {
    expect(groupByDomain([]).size).toBe(0);
  });
});
