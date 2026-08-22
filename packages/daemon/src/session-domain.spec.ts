import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import {
  type DomainLookup,
  UnknownDomainError,
  UnresolvedDomainScopeError,
  applyDomainScope,
  classifyAgentTool,
  domainIdForPath,
  resolveDomainFilter,
  resolveSpawnDomainId,
} from "./session-domain";

function domain(id: number, name: string, path: string, host: string | null = null): Domain {
  return { id, name, host, path, createdAt: "2026-08-22T00:00:00.000Z" };
}

/**
 * A `DomainLookup` over a fixed list, resolving by longest matching prefix — the
 * same rule `StateDb.resolveDomain` applies, without a SQLite file. Segment-aware
 * so the sibling-prefix cases below are testing the real rule and not a stub that
 * happens to agree with it.
 */
function lookup(domains: Domain[]): DomainLookup {
  return {
    getDomainByName: (name) => domains.find((d) => d.name === name) ?? null,
    resolveDomain: (path) => {
      let best: Domain | null = null;
      for (const d of domains) {
        if (d.host !== null) continue;
        if (path !== d.path && !path.startsWith(`${d.path}/`)) continue;
        if (best === null || d.path.length > best.path.length) best = d;
      }
      return best;
    },
  };
}

const PHOENIX = domain(1, "phoenix", "/home/u/github/phoenix");
const BAR = domain(2, "bar", "/foo/bar");
const BARBAZ = domain(3, "barbaz", "/foo/barbaz");
const db = lookup([PHOENIX, BAR, BARBAZ]);

// ── classifyAgentTool ──

describe("classifyAgentTool", () => {
  test("classifies every registered provider, not just claude", () => {
    // NOTE: this asserts the CLASSIFIER only. It passed while four of five workers
    // then threw the resolved id away on `wait` — the "asserts the column, not the
    // constraint" shape. The enforcement half now lives in
    // `session-domain-roundtrip.spec.ts`, which exercises each provider's real
    // handleWait. Keep both: this one localizes a registry regression, that one
    // catches a worker that stops honouring the partition.
    for (const [server, prefix] of [
      ["_claude", "claude"],
      ["_codex", "codex"],
      ["_opencode", "opencode"],
      ["_acp", "acp"],
      ["_mock", "mock"],
    ] as const) {
      expect(classifyAgentTool(server, `${prefix}_prompt`)).toBe("spawn");
      expect(classifyAgentTool(server, `${prefix}_session_list`)).toBe("filter");
      expect(classifyAgentTool(server, `${prefix}_wait`)).toBe("filter");
    }
  });

  test("tools addressed by an explicit sessionId are not domain-scoped", () => {
    for (const tool of ["claude_bye", "claude_interrupt", "claude_transcript", "claude_session_status"]) {
      expect(classifyAgentTool("_claude", tool)).toBeNull();
    }
  });

  test("non-agent servers are untouched", () => {
    expect(classifyAgentTool("_aliases", "some_tool")).toBeNull();
    expect(classifyAgentTool("atlassian", "search")).toBeNull();
  });
});

// ── domainIdForPath ──

describe("domainIdForPath", () => {
  test("resolves a path inside a domain", () => {
    expect(domainIdForPath(db, "/home/u/github/phoenix/src")).toBe(PHOENIX.id);
  });

  test("a path outside every domain is the unassigned sentinel, never a guess", () => {
    expect(domainIdForPath(db, "/somewhere/else")).toBe(NO_DOMAIN_ID);
  });

  test("sibling-prefix paths do not cross-match", () => {
    // The bug scopeRoot shipped: `/foo/barbaz`.startsWith(`/foo/bar`) is true.
    expect(domainIdForPath(db, "/foo/barbaz")).toBe(BARBAZ.id);
    expect(domainIdForPath(db, "/foo/barbaz/src")).toBe(BARBAZ.id);
    expect(domainIdForPath(db, "/foo/bar/src")).toBe(BAR.id);
  });

  test("a relative or empty path is the sentinel rather than a throw", () => {
    expect(domainIdForPath(db, "relative/path")).toBe(NO_DOMAIN_ID);
    expect(domainIdForPath(db, "")).toBe(NO_DOMAIN_ID);
    expect(domainIdForPath(db, undefined)).toBe(NO_DOMAIN_ID);
  });

  test("a storage fault PROPAGATES rather than silently widening scope", () => {
    // Swallowing this returned the sentinel, which toDomainFilter turns into "no
    // filter" — a locked or corrupt DB degraded into listing every domain's sessions,
    // output-identical to `--all`, with nothing said.
    const angry: DomainLookup = {
      getDomainByName: () => null,
      resolveDomain: () => {
        throw new Error("database is locked");
      },
    };
    expect(() => domainIdForPath(angry, "/foo/bar")).toThrow(/database is locked/);
  });
});

// ── resolveSpawnDomainId ──

describe("resolveSpawnDomainId", () => {
  test("records the domain of the spawn cwd", () => {
    expect(resolveSpawnDomainId(db, { cwd: "/home/u/github/phoenix/wt" }, undefined)).toBe(PHOENIX.id);
  });

  test("falls back to repoRoot, then to the caller's cwd", () => {
    expect(resolveSpawnDomainId(db, { repoRoot: "/foo/bar" }, undefined)).toBe(BAR.id);
    expect(resolveSpawnDomainId(db, {}, "/foo/barbaz")).toBe(BARBAZ.id);
  });

  test("cwd wins over repoRoot when both resolve — the inner domain owns the session", () => {
    expect(resolveSpawnDomainId(db, { cwd: "/foo/barbaz", repoRoot: "/foo/bar" }, undefined)).toBe(BARBAZ.id);
  });

  test("skips a candidate that resolves to nothing rather than stopping at it", () => {
    expect(resolveSpawnDomainId(db, { cwd: "/nowhere", repoRoot: "/foo/bar" }, undefined)).toBe(BAR.id);
  });

  test("outside every domain records the sentinel", () => {
    expect(resolveSpawnDomainId(db, { cwd: "/nowhere" }, "/also/nowhere")).toBe(NO_DOMAIN_ID);
  });

  test("an explicit domain name outranks every path", () => {
    expect(resolveSpawnDomainId(db, { domain: "phoenix", cwd: "/foo/bar" }, undefined)).toBe(PHOENIX.id);
  });

  test("an unregistered domain name throws — a spawn never lands somewhere else", () => {
    expect(() => resolveSpawnDomainId(db, { domain: "nope" }, undefined)).toThrow(UnknownDomainError);
  });
});

// ── resolveDomainFilter ──

describe("resolveDomainFilter", () => {
  test('no scoping argument is "none" — this is how --all is spelled', () => {
    expect(resolveDomainFilter(db, {})).toEqual({ kind: "none" });
  });

  test("does NOT fall back to a spawn-style cwd/repoRoot argument", () => {
    // Only `domain` and `domainCwd` scope a listing. If `cwd` also did, `--all` would
    // need a second flag to switch scoping back off.
    expect(resolveDomainFilter(db, { cwd: "/foo/bar", repoRoot: "/foo/bar" })).toEqual({ kind: "none" });
  });

  test("domainCwd inside a domain resolves to that domain", () => {
    expect(resolveDomainFilter(db, { domainCwd: "/home/u/github/phoenix/src" })).toEqual({
      kind: "domain",
      id: PHOENIX.id,
    });
  });

  test('a domainCwd outside every domain is "unresolved" — NOT "none"', () => {
    // THE #3199 BUG. These two collapsed into one `undefined`, so a bulk bye read
    // "I asked for a scope and did not get one" as "I asked for no scope" and ended
    // every session on the machine. They must be distinguishable.
    const outside = resolveDomainFilter(db, { domainCwd: "/nowhere" });
    expect(outside).toEqual({ kind: "unresolved", requested: "/nowhere" });
    expect(outside.kind).not.toBe("none");
    expect(resolveDomainFilter(db, {}).kind).toBe("none");
  });

  test("an explicit name works from anywhere and outranks domainCwd", () => {
    expect(resolveDomainFilter(db, { domain: "phoenix", domainCwd: "/foo/bar" })).toEqual({
      kind: "domain",
      id: PHOENIX.id,
    });
  });

  test("an unregistered name throws — never 'unresolved', that is a caller error", () => {
    expect(() => resolveDomainFilter(db, { domain: "nope" })).toThrow(UnknownDomainError);
  });

  test("sibling-prefix directories select different domains", () => {
    expect(resolveDomainFilter(db, { domainCwd: "/foo/barbaz/src" })).toEqual({ kind: "domain", id: BARBAZ.id });
    expect(resolveDomainFilter(db, { domainCwd: "/foo/bar/src" })).toEqual({ kind: "domain", id: BAR.id });
  });
});

// ── requireScope: the destructive-caller contract ──

describe("requireScope (#3199)", () => {
  test("a listing degrades to unscoped, as it always did — read-only, so widening is safe", () => {
    expect(applyDomainScope(db, "_claude", "claude_session_list", { domainCwd: "/nowhere" }, undefined)).toEqual({});
  });

  test("but a caller that REQUIRES a scope is refused rather than silently widened", () => {
    // `mcx claude bye --all` from a directory outside every registered domain. Pre-fix
    // this returned {} and the bulk loop ended every session in every domain.
    expect(() =>
      applyDomainScope(db, "_claude", "claude_session_list", { domainCwd: "/nowhere", requireScope: true }, undefined),
    ).toThrow(UnresolvedDomainScopeError);
  });

  test("repoRoot counts as a scope, so a bulk bye inside a repo still works", () => {
    // The common case, and refusing it would be a serious regression.
    const out = applyDomainScope(
      db,
      "_claude",
      "claude_session_list",
      { domainCwd: "/nowhere", repoRoot: "/some/repo", requireScope: true },
      undefined,
    );
    expect(out).toEqual({ repoRoot: "/some/repo" });
  });

  test("a resolved domain satisfies requireScope", () => {
    const out = applyDomainScope(
      db,
      "_claude",
      "claude_session_list",
      { domainCwd: "/home/u/github/phoenix", requireScope: true },
      undefined,
    );
    expect(out).toEqual({ domainId: PHOENIX.id });
  });

  test("requireScope never reaches a worker", () => {
    const out = applyDomainScope(
      db,
      "_claude",
      "claude_session_list",
      { domain: "phoenix", requireScope: true },
      undefined,
    );
    expect(out).not.toHaveProperty("requireScope");
  });

  test("requireScope with NO scoping argument at all is still refused", () => {
    // "I require a scope" plus "I gave you nothing to scope by" is a caller error, and
    // for a destructive verb it must not silently mean everything.
    expect(() =>
      applyDomainScope(db, "_claude", "claude_session_list", { domainCwd: "/nowhere", requireScope: true }, undefined),
    ).toThrow(/did not resolve/);
  });
});

// ── applyDomainScope ──

describe("applyDomainScope", () => {
  test("a worker never receives a domain name or a domainCwd — only an id", () => {
    const out = applyDomainScope(db, "_claude", "claude_session_list", { domain: "phoenix" }, undefined);
    expect(out).toEqual({ domainId: PHOENIX.id });
    expect("domain" in out).toBe(false);
    expect("domainCwd" in out).toBe(false);
  });

  test("strips the raw scoping args even when nothing resolved", () => {
    const out = applyDomainScope(db, "_codex", "codex_session_list", { domainCwd: "/nowhere" }, undefined);
    expect(out).toEqual({});
  });

  test("a spawn always carries a domainId, even the sentinel", () => {
    // A partition column with no writer reads as "no sessions here" rather than
    // "not recorded" — so a spawn is never allowed to omit one.
    const out = applyDomainScope(db, "_acp", "acp_prompt", { prompt: "hi", cwd: "/nowhere" }, undefined);
    expect(out.domainId).toBe(NO_DOMAIN_ID);
    expect(out.prompt).toBe("hi");
  });

  test("every provider's spawn records the domain, not just claude's", () => {
    for (const [server, prefix] of [
      ["_claude", "claude"],
      ["_codex", "codex"],
      ["_opencode", "opencode"],
      ["_acp", "acp"],
      ["_mock", "mock"],
    ] as const) {
      const out = applyDomainScope(db, server, `${prefix}_prompt`, { cwd: "/foo/bar" }, undefined);
      expect(out.domainId).toBe(BAR.id);
    }
  });

  test("a spawn with NO cwd argument still records the caller's domain", () => {
    // The previous version of this file always supplied `cwd`, which is the one
    // argument `mcx agent <provider> spawn` omitted — so it passed while every
    // agent-CLI spawn booked into domain 0 and went invisible to its own `ls`.
    // Drop the `cwd` and the caller cwd is all that is left to resolve from.
    for (const prefix of ["claude", "codex", "opencode", "acp", "mock"] as const) {
      const out = applyDomainScope(db, `_${prefix}`, `${prefix}_prompt`, { prompt: "hi" }, "/foo/bar/sub");
      expect(out.domainId).toBe(BAR.id);
    }
  });

  test("with no cwd anywhere, a spawn records the sentinel rather than throwing", () => {
    const out = applyDomainScope(db, "_codex", "codex_prompt", { prompt: "hi" }, undefined);
    expect(out.domainId).toBe(NO_DOMAIN_ID);
  });

  test("a caller-supplied domainId is STRIPPED, never honoured", () => {
    // This test used to assert the opposite and codified the bypass as intended
    // behaviour. A raw id beat an explicit `-d` name, so `UnknownDomainError` never
    // fired, `toDomainFilter` never got to veto 0, and a row could be written against
    // a domains id with no row behind it.
    const out = applyDomainScope(db, "_claude", "claude_wait", { domainId: 99, domain: "phoenix" }, undefined);
    expect(out.domainId).toBe(PHOENIX.id);
  });

  test("a raw domainId cannot smuggle an unregistered domain past UnknownDomainError", () => {
    expect(() =>
      applyDomainScope(db, "_claude", "claude_session_list", { domain: "nope", domainId: 42 }, undefined),
    ).toThrow(UnknownDomainError);
  });

  test("a raw domainId cannot ask the unaskable question (filter on domain 0)", () => {
    const out = applyDomainScope(db, "_claude", "claude_session_list", { domainId: NO_DOMAIN_ID }, undefined);
    expect(out).not.toHaveProperty("domainId");
  });

  test("a raw domainId cannot write a session into a domain that does not exist", () => {
    const out = applyDomainScope(db, "_codex", "codex_prompt", { prompt: "x", domainId: 4242 }, "/foo/bar");
    expect(out.domainId).toBe(BAR.id);
  });

  test("junk numeric ids (negative, fractional, Infinity) are stripped like any other", () => {
    for (const junk of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const out = applyDomainScope(db, "_claude", "claude_session_list", { domainId: junk }, undefined);
      expect(out).not.toHaveProperty("domainId");
    }
  });

  test("NEVER touches a third-party server's arguments — byte-identical pass-through", () => {
    // `handlers/tool.ts` calls this for EVERY callTool with no server guard, so a strip
    // that escapes the agent namespace deletes `domain` from `mcx call atlassian search`
    // — one of the most common vendor parameter names there is. Asserted with `toBe`,
    // not `toEqual`: the guarantee is that the SAME OBJECT comes back untouched, so no
    // future rebuild-and-return can weaken this to a shallow copy that drops a key.
    for (const server of ["atlassian", "github", "cloudflare", "_aliases", "_metrics", "_site"]) {
      const args = { domain: "acme.atlassian.net", domainCwd: "/x", domainId: 9, query: "bug" };
      expect(applyDomainScope(db, server, "search", args, "/foo/bar")).toBe(args);
    }
  });

  test("a tool name that looks like an agent tool on a foreign server is still untouched", () => {
    // `classifyAgentTool` answers null for both "not my server" and "my server,
    // unscoped tool". Only the first may pass through unstripped, so the two must not
    // share a branch — this pins that they do not.
    const args = { domain: "acme", prompt: "hi" };
    expect(applyDomainScope(db, "some-vendor", "claude_prompt", args, "/foo/bar")).toBe(args);
  });

  test("a non-scoped AGENT tool still has the raw scoping args stripped", () => {
    // Previously these returned `args` untouched, so `claude_bye` forwarded the raw
    // domain NAME to the worker — the seam through which a second key regrows.
    const args = { sessionId: "abc", domain: "phoenix", domainCwd: "/foo/bar", domainId: 7 };
    // Every AGENT server strips, whatever the tool — a worker must never see a raw
    // name or a caller-supplied id.
    for (const [server, tool] of [
      ["_claude", "claude_bye"],
      ["_codex", "codex_interrupt"],
      ["_acp", "acp_transcript"],
      ["_opencode", "opencode_session_status"],
      ["_mock", "mock_approve"],
    ] as const) {
      expect(applyDomainScope(db, server, tool, args, undefined)).toEqual({ sessionId: "abc" });
    }
    // `_aliases` is NOT an agent server, so it is left alone — this line used to assert
    // the opposite, which was the bug: the strip had escaped the agent namespace.
    expect(applyDomainScope(db, "_aliases", "anything", args, undefined)).toBe(args);
  });

  test("a listing with no scoping args is left unscoped (--all)", () => {
    expect(applyDomainScope(db, "_claude", "claude_session_list", { repoRoot: "/foo/bar" }, "/foo/bar")).toEqual({
      repoRoot: "/foo/bar",
    });
  });
});
