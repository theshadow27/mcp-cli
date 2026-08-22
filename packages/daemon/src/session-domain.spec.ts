import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import {
  type DomainLookup,
  UnknownDomainError,
  applyDomainScope,
  classifyAgentTool,
  domainIdForPath,
  resolveFilterDomainId,
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

// ── resolveFilterDomainId ──

describe("resolveFilterDomainId", () => {
  test("no scoping argument means no filter — this is how --all is spelled", () => {
    expect(resolveFilterDomainId(db, {})).toBeUndefined();
  });

  test("does NOT fall back to a spawn-style cwd/repoRoot argument", () => {
    // Only `domain` and `domainCwd` scope a listing. If `cwd` also did, `--all`
    // would need a second flag to switch scoping back off.
    expect(resolveFilterDomainId(db, { cwd: "/foo/bar", repoRoot: "/foo/bar" })).toBeUndefined();
  });

  test("domainCwd scopes to the domain owning that directory", () => {
    expect(resolveFilterDomainId(db, { domainCwd: "/home/u/github/phoenix/src" })).toBe(PHOENIX.id);
  });

  test("a domainCwd outside every domain is no filter, not a filter on domain 0", () => {
    expect(resolveFilterDomainId(db, { domainCwd: "/nowhere" })).toBeUndefined();
  });

  test("an explicit name works from anywhere and outranks domainCwd", () => {
    expect(resolveFilterDomainId(db, { domain: "phoenix", domainCwd: "/foo/bar" })).toBe(PHOENIX.id);
  });

  test("an unregistered name throws rather than silently showing everything", () => {
    expect(() => resolveFilterDomainId(db, { domain: "nope" })).toThrow(UnknownDomainError);
  });

  test("sibling-prefix directories select different domains", () => {
    expect(resolveFilterDomainId(db, { domainCwd: "/foo/barbaz/src" })).toBe(BARBAZ.id);
    expect(resolveFilterDomainId(db, { domainCwd: "/foo/bar/src" })).toBe(BAR.id);
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

  test("a non-scoped tool still has the raw scoping args stripped", () => {
    // Previously these returned `args` untouched, so `claude_bye` forwarded the raw
    // domain NAME to the worker — the seam through which a second key regrows.
    const args = { sessionId: "abc", domain: "phoenix", domainCwd: "/foo/bar", domainId: 7 };
    expect(applyDomainScope(db, "_claude", "claude_bye", args, undefined)).toEqual({ sessionId: "abc" });
    expect(applyDomainScope(db, "_aliases", "anything", args, undefined)).toEqual({ sessionId: "abc" });
  });

  test("a listing with no scoping args is left unscoped (--all)", () => {
    expect(applyDomainScope(db, "_claude", "claude_session_list", { repoRoot: "/foo/bar" }, "/foo/bar")).toEqual({
      repoRoot: "/foo/bar",
    });
  });
});
