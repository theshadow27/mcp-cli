import { describe, expect, test } from "bun:test";
import { type Domain, NO_DOMAIN_ID, UNASSIGNED_DOMAIN_NAME } from "@mcp-cli/core";
import { type MailDomainDb, resolveCallerDomain, resolveDelivery } from "./mail-domain";

/**
 * Addressing and precedence only.
 *
 * The partition semantics — who can read what — are asserted in `handlers/mail.spec.ts`
 * and `db/state.spec.ts` against a **concrete `StateDb`**, deliberately not here. A fake
 * can present a combination of states the real database cannot produce, and mutation-
 * testing a guard against such a fake proves the fake is wired to the guard, not that the
 * guard is reachable. That is precisely how an unreachable guard survived review once in
 * this file's history.
 */

function domain(id: number, name: string, path: string, host: string | null = null): Domain {
  return { id, name, host, path, createdAt: "2026-08-22 00:00:00" };
}

function fakeDb(domains: Domain[]): MailDomainDb {
  return {
    getDomainByName: (name) => domains.find((d) => d.name === name) ?? null,
    resolveDomain: (path) => {
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

const alpha = { id: 1, name: "alpha" };
const beta = { id: 2, name: "beta" };
const unassigned = { id: NO_DOMAIN_ID, name: UNASSIGNED_DOMAIN_NAME };

describe("resolveCallerDomain", () => {
  test("resolves cwd to the domain owning it", () => {
    expect(resolveCallerDomain(BOTH, { cwd: "/work/alpha/src/deep" })).toEqual(alpha);
    expect(resolveCallerDomain(BOTH, { cwd: "/work/beta" })).toEqual(beta);
  });

  test("-d wins over cwd", () => {
    expect(resolveCallerDomain(BOTH, { cwd: "/work/alpha", domain: "beta" })).toEqual(beta);
  });

  test("an unknown -d is an error, not a new partition", () => {
    expect(() => resolveCallerDomain(BOTH, { cwd: "/work/alpha", domain: "nosuchdomain" })).toThrow(/unknown domain/);
  });

  /**
   * #3038 RED 1. This is the property that keeps mail alive on a box where the `domains`
   * table filled itself at daemon boot from a `mcx scope` sidecar. The earlier revision
   * returned partition 0 ONLY when `domains` was empty, so the first auto-imported domain
   * row orphaned the entire mail history — including the operator mailbox.
   */
  test("a cwd outside every domain is partition 0 — whether or not domains exist", () => {
    expect(resolveCallerDomain(EMPTY, { cwd: "/tmp/elsewhere" })).toEqual(unassigned);
    expect(resolveCallerDomain(BOTH, { cwd: "/tmp/elsewhere" })).toEqual(unassigned);
    // The specific shape of the regression: one unrelated domain registered, caller far away.
    expect(
      resolveCallerDomain(fakeDb([domain(1, "gerald", "/home/u/github/gerald")]), { cwd: "/home/u/other" }),
    ).toEqual(unassigned);
  });

  test("partition 0 is reachable by name, so orphaned mail is addressable", () => {
    expect(resolveCallerDomain(BOTH, { domain: UNASSIGNED_DOMAIN_NAME })).toEqual(unassigned);
    expect(resolveCallerDomain(BOTH, { cwd: "/work/alpha", domain: UNASSIGNED_DOMAIN_NAME })).toEqual(unassigned);
  });

  test("no cwd and no -d is an error — the daemon's own cwd is never consulted", () => {
    expect(() => resolveCallerDomain(EMPTY, {})).toThrow(/requires a domain scope/);
    expect(() => resolveCallerDomain(BOTH, { cwd: "   " })).toThrow(/requires a domain scope/);
    expect(() => resolveCallerDomain(BOTH, { domain: "  " })).toThrow(/requires a domain scope/);
  });

  /**
   * #3038 review finding #6. `resolveDomainForPath` (`core/src/domain.ts`) already skips
   * host-bound rows when resolving a path — a host-bound domain names a directory on
   * another machine, never one on this filesystem — so a `-d <host-bound>` is the only
   * way to reach one here. Without this guard the row lands in the LOCAL `mail` table and
   * nobody on the remote host ever reads it.
   */
  test("-d naming a host-bound domain fails closed rather than delivering locally", () => {
    const remote = domain(3, "remote", "/home/other/phoenix", "boxen0010");
    const db = fakeDb([ALPHA, remote]);
    expect(() => resolveCallerDomain(db, { domain: "remote" })).toThrow(/host-bound/);
    expect(() => resolveCallerDomain(db, { cwd: "/work/alpha", domain: "remote" })).toThrow(/host-bound/);
  });
});

describe("resolveDelivery", () => {
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
    expect(resolveDelivery(BOTH, alpha, "worker", "orchestrator@alpha")).toEqual({
      domain: alpha,
      recipient: "orchestrator",
      sender: "worker",
      crossDomain: false,
    });
  });

  test("an unknown domain in the recipient errors at send time", () => {
    expect(() => resolveDelivery(BOTH, alpha, "worker", "orchestrator@nosuchdomain")).toThrow(/unknown domain/);
  });

  /**
   * #3038 review finding #6. `orch@remote` must not land in the local `mail` table when
   * `remote` is a host-bound domain — nobody on that host would ever read the row. Fails
   * closed instead, matching the resolver's own directive at `core/src/domain.ts`.
   */
  test("a recipient naming a host-bound domain errors at send time rather than landing locally", () => {
    const remote = domain(3, "remote", "/home/other/phoenix", "boxen0010");
    const db = fakeDb([ALPHA, remote]);
    expect(() => resolveDelivery(db, alpha, "worker", "orch@remote")).toThrow(/host-bound/);
  });

  test("a reply to a qualified sender routes back across the boundary", () => {
    expect(resolveDelivery(BOTH, beta, "orchestrator", "worker@alpha")).toEqual({
      domain: alpha,
      recipient: "worker",
      sender: "orchestrator@beta",
      crossDomain: true,
    });
  });

  /**
   * #3038 RED 1, delivery half. Partition 0 has a name, so it can both address other
   * domains and be addressed — and a reply to a message it sent routes home rather than
   * landing on a same-named mailbox in the recipient's domain.
   */
  test("partition 0 can send across a boundary and receive the reply", () => {
    const out = resolveDelivery(BOTH, unassigned, "worker", "orchestrator@alpha");
    expect(out).toEqual({
      domain: alpha,
      recipient: "orchestrator",
      sender: `worker@${UNASSIGNED_DOMAIN_NAME}`,
      crossDomain: true,
    });
    // alpha replies to that return address: back to partition 0, not to alpha's own `worker`.
    expect(resolveDelivery(BOTH, alpha, "orchestrator", out.sender)).toEqual({
      domain: unassigned,
      recipient: "worker",
      sender: "orchestrator@alpha",
      crossDomain: true,
    });
  });

  test("a named domain can address partition 0 explicitly", () => {
    expect(resolveDelivery(BOTH, alpha, "worker", `boss@${UNASSIGNED_DOMAIN_NAME}`)).toEqual({
      domain: unassigned,
      recipient: "boss",
      sender: "worker@alpha",
      crossDomain: true,
    });
  });

  test("bare addressing inside partition 0 stays there", () => {
    expect(resolveDelivery(BOTH, unassigned, "orchestrator", "boss")).toEqual({
      domain: unassigned,
      recipient: "boss",
      sender: "orchestrator",
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

  /**
   * #3038 RED 3 — the smuggling channel. `evil@beta@alpha` splits to local `evil@beta`
   * with the caller's OWN domain as the suffix, so the spoof check passes; it stored as
   * a bare-looking `evil@beta`, and the victim's reply re-parsed that as evil AT beta and
   * carried the body out of alpha. Neither party ever typed `user@domain`.
   */
  test("an address cannot smuggle a second address in its local part", () => {
    expect(() => resolveDelivery(BOTH, alpha, "evil@beta@alpha", "orchestrator")).toThrow(/local part/);
    expect(() => resolveDelivery(BOTH, alpha, "worker", "evil@beta@alpha")).toThrow(/local part/);
    // And the payload the smuggle would have produced is itself unusable as a sender:
    // `evil@beta` from alpha is caught by the spoof guard, so it can never be stored
    // bare and then weaponised on reply.
    expect(() => resolveDelivery(BOTH, alpha, "evil@beta", "orchestrator")).toThrow(/may only be qualified/);
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

  test("a malformed address is refused rather than half-understood", () => {
    expect(() => resolveDelivery(BOTH, alpha, "x", "orchestrator@")).toThrow(/empty domain/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "@alpha")).toThrow(/empty local part/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "")).toThrow(/empty/);
    expect(() => resolveDelivery(BOTH, alpha, "x", "orchestrator@not a domain")).toThrow(/invalid domain/);
  });
});
