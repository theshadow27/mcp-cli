import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID } from "@mcp-cli/core";
import { type MailDomainDb, resolveCallerDomain, resolveDelivery } from "./mail-domain";

function domain(id: number, name: string, path: string, host: string | null = null): Domain {
  return { id, name, host, path, createdAt: "2026-08-22 00:00:00" };
}

/** In-memory stand-in for the domains half of StateDb — the resolver needs nothing else. */
function fakeDb(domains: Domain[]): MailDomainDb {
  return {
    listDomains: () => domains,
    getDomainByName: (name) => domains.find((d) => d.name === name) ?? null,
    resolveDomain: (path) => {
      // Longest matching local prefix, mirroring resolveDomainForPath.
      let best: Domain | null = null;
      for (const d of domains) {
        if (d.host !== null) continue;
        if (path === d.path || path.startsWith(`${d.path}/`)) {
          if (!best || d.path.length > best.path.length) best = d;
        }
      }
      return best;
    },
  };
}

const ALPHA = domain(1, "alpha", "/work/alpha");
const BETA = domain(2, "beta", "/work/beta");
const BOTH = fakeDb([ALPHA, BETA]);
const EMPTY = fakeDb([]);

describe("resolveCallerDomain", () => {
  test("resolves cwd to the domain owning it", () => {
    expect(resolveCallerDomain(BOTH, { cwd: "/work/alpha/src/deep" })).toEqual({ id: 1, name: "alpha" });
    expect(resolveCallerDomain(BOTH, { cwd: "/work/beta" })).toEqual({ id: 2, name: "beta" });
  });

  test("-d wins over cwd", () => {
    expect(resolveCallerDomain(BOTH, { cwd: "/work/alpha", domain: "beta" })).toEqual({ id: 2, name: "beta" });
  });

  test("an unknown -d is an error, not a new partition", () => {
    expect(() => resolveCallerDomain(BOTH, { cwd: "/work/alpha", domain: "nosuchdomain" })).toThrow(/unknown domain/);
  });

  test("cwd outside every domain is an error once any domain exists", () => {
    expect(() => resolveCallerDomain(BOTH, { cwd: "/tmp/elsewhere" })).toThrow(/outside every registered domain/);
  });

  test("cwd outside every domain is the unassigned partition only when none are registered", () => {
    expect(resolveCallerDomain(EMPTY, { cwd: "/tmp/elsewhere" })).toEqual({ id: NO_DOMAIN_ID, name: null });
  });

  test("no cwd and no -d is an error — the daemon's own cwd is never consulted", () => {
    expect(() => resolveCallerDomain(EMPTY, {})).toThrow(/requires a domain scope/);
    expect(() => resolveCallerDomain(BOTH, { cwd: "   " })).toThrow(/requires a domain scope/);
    expect(() => resolveCallerDomain(BOTH, { domain: "  " })).toThrow(/requires a domain scope/);
  });
});

describe("resolveDelivery", () => {
  const alpha = { id: 1, name: "alpha" };
  const beta = { id: 2, name: "beta" };
  const unassigned = { id: NO_DOMAIN_ID, name: null };

  test("a bare recipient stays in the caller's domain", () => {
    expect(resolveDelivery(BOTH, alpha, "worker", "orchestrator")).toEqual({
      domain: alpha,
      recipient: "orchestrator",
      sender: "worker",
      crossDomain: false,
    });
  });

  test("user@domain delivers into that domain and qualifies the sender for the reply", () => {
    expect(resolveDelivery(BOTH, alpha, "worker", "orchestrator@beta")).toEqual({
      domain: beta,
      recipient: "orchestrator",
      sender: "worker@alpha",
      crossDomain: true,
    });
  });

  test("user@own-domain is not a cross-domain send", () => {
    const r = resolveDelivery(BOTH, alpha, "worker", "orchestrator@alpha");
    expect(r).toEqual({ domain: alpha, recipient: "orchestrator", sender: "worker", crossDomain: false });
  });

  test("an unknown domain in the recipient errors at send time", () => {
    expect(() => resolveDelivery(BOTH, alpha, "worker", "orchestrator@nosuchdomain")).toThrow(/unknown domain/);
  });

  test("a cross-domain send from the unassigned partition is refused — no return address", () => {
    expect(() => resolveDelivery(BOTH, unassigned, "worker", "orchestrator@alpha")).toThrow(/no.*return address/s);
  });

  test("bare addressing still works from the unassigned partition", () => {
    expect(resolveDelivery(EMPTY, unassigned, "worker", "boss")).toEqual({
      domain: unassigned,
      recipient: "boss",
      sender: "worker",
      crossDomain: false,
    });
  });

  test("a sender may not claim another domain", () => {
    expect(() => resolveDelivery(BOTH, alpha, "worker@beta", "orchestrator")).toThrow(/may only be qualified/);
    expect(() => resolveDelivery(BOTH, unassigned, "worker@alpha", "boss")).toThrow(/may only be qualified/);
  });

  test("a sender qualified with its own domain is accepted and stored bare in-domain", () => {
    expect(resolveDelivery(BOTH, alpha, "worker@alpha", "orchestrator").sender).toBe("worker");
  });

  test("a reply to a qualified sender routes back across the boundary", () => {
    // beta received `worker@alpha`; replying addresses that string verbatim.
    const reply = resolveDelivery(BOTH, beta, "orchestrator", "worker@alpha");
    expect(reply).toEqual({
      domain: alpha,
      recipient: "worker",
      sender: "orchestrator@beta",
      crossDomain: true,
    });
  });

  test("broadcast is domain-local, and @domain broadcasts into that domain", () => {
    expect(resolveDelivery(BOTH, alpha, "admin", "*")).toEqual({
      domain: alpha,
      recipient: "*",
      sender: "admin",
      crossDomain: false,
    });
    expect(resolveDelivery(BOTH, alpha, "admin", "*@beta").domain).toEqual(beta);
  });

  test("a local part containing @ splits on the LAST @", () => {
    // `claude-a@b` is the mailbox name; `@alpha` is the domain. Splitting on the FIRST
    // `@` would give local `claude-a` in the invalid domain `b@alpha`.
    expect(resolveDelivery(BOTH, beta, "x", "claude-a@b@alpha")).toEqual({
      domain: alpha,
      recipient: "claude-a@b",
      sender: "x@beta",
      crossDomain: true,
    });
  });

  test("the trailing segment is ALWAYS read as a domain — a bare name with @ is not a local part", () => {
    // The documented cost of adopting the syntax: a pre-#3038 mailbox literally named
    // `claude-a@b` is now `claude-a` at domain `b`, and errors because `b` is not
    // registered. It fails closed and loudly rather than delivering somewhere plausible.
    expect(() => resolveDelivery(BOTH, alpha, "x", "claude-a@b")).toThrow(/unknown domain "b"/);
  });

  test("a malformed address is refused rather than half-understood", () => {
    expect(() => resolveDelivery(BOTH, alpha, "x", "orchestrator@")).toThrow(/empty domain/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "@alpha")).toThrow(/empty local part/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "")).toThrow(/empty/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "orchestrator@not a domain")).toThrow(/invalid domain/);
  });
});
