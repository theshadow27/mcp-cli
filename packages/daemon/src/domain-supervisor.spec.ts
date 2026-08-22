import { describe, expect, test } from "bun:test";
import { type Domain, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import { RemoteDomainError } from "./domain-server";
import {
  type DomainRegistry,
  DomainSupervisor,
  type DomainWorkerStatus,
  SupervisorStoppedError,
  UnknownDomainError,
  isTransientStatus,
} from "./domain-supervisor";
import type { RestartPolicy } from "./restart-policy";
import { type FakeDomainLink, makeFakeDomainLink, makeStubDomainClient } from "./test-helpers";

const FAST_POLICY: RestartPolicy = { maxCrashes: 3, crashWindowMs: 60_000, backoffDelaysMs: [0, 0, 0] };

function domain(id: number, name: string, overrides?: Partial<Domain>): Domain {
  return { id, name, host: null, path: `/projects/${name}`, createdAt: "2026-08-22T00:00:00Z", ...overrides };
}

/** An in-memory stand-in for the `domains` table. */
class FakeRegistry implements DomainRegistry {
  constructor(private rows: Domain[]) {}
  getDomainById(id: number): Domain | null {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  getDomainByName(name: string): Domain | null {
    return this.rows.find((r) => r.name === name) ?? null;
  }
  listDomains(): Domain[] {
    return [...this.rows];
  }
  replace(rows: Domain[]): void {
    this.rows = rows;
  }
}

interface Harness {
  supervisor: DomainSupervisor;
  registry: FakeRegistry;
  links: FakeDomainLink[];
  linksFor: (domainId: number) => FakeDomainLink[];
}

function makeSupervisor(rows: Domain[], linkOptions?: Parameters<typeof makeFakeDomainLink>[1]): Harness {
  const registry = new FakeRegistry(rows);
  const links: FakeDomainLink[] = [];
  const supervisor = new DomainSupervisor({
    registry,
    logger: silentLogger,
    restartPolicy: FAST_POLICY,
    linkFactory: (d) => {
      const link = makeFakeDomainLink(d, linkOptions);
      links.push(link);
      return link;
    },
    // The real MCP client is exercised end-to-end in domain-worker.spec.ts;
    // here what is under test is supervision, not the SDK.
    clientFactory: () => makeStubDomainClient(),
  });

  return {
    supervisor,
    registry,
    links,
    linksFor: (domainId) => links.filter((l) => l.sent.some((m) => m.domain.id === domainId)),
  };
}

describe("DomainSupervisor.ensure", () => {
  test("two domains get two workers, each bound to its own row", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);

    const first = await h.supervisor.ensure(1);
    const second = await h.supervisor.ensure(2);

    expect(first).not.toBe(second);
    expect(first.domain.name).toBe("phoenix");
    expect(second.domain.name).toBe("clrg");
    expect(h.linksFor(1)).toHaveLength(1);
    expect(h.linksFor(2)).toHaveLength(1);
    // Each worker was handed its own domain and only its own.
    expect(h.linksFor(1)[0]?.sent[0]?.domain.path).toBe("/projects/phoenix");
    expect(h.linksFor(2)[0]?.sent[0]?.domain.path).toBe("/projects/clrg");
    await h.supervisor.stopAll();
  });

  test("returns the same worker on a second call — one per domain, not one per caller", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);

    const a = await h.supervisor.ensure(1);
    const b = await h.supervisor.ensure(1);

    expect(a).toBe(b);
    expect(h.links).toHaveLength(1);
    await h.supervisor.stopAll();
  });

  test("concurrent callers get one worker, and it is actually running", async () => {
    // The previous version asserted object identity only, which passed for the
    // wrong reason: `servers` is populated synchronously before `start()`
    // resolves, so a second caller matched the cache and was handed a server
    // that had not started — making the `starting` map dead code and ensure()'s
    // own contract false.
    const h = makeSupervisor([domain(1, "phoenix")]);

    const [a, b, c] = await Promise.all([h.supervisor.ensure(1), h.supervisor.ensure(1), h.supervisor.ensure(1)]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.links).toHaveLength(1);
    for (const server of [a, b, c]) expect(server.state).toBe("running");
    await h.supervisor.stopAll();
  });

  test("a slow start still resolves every concurrent caller with a running worker", async () => {
    const h = makeSupervisor([domain(1, "phoenix")], { autoReady: false });
    const callers = [h.supervisor.ensure(1), h.supervisor.ensure(1)];
    await pollUntil(() => h.links.length === 1);
    // Mid-handshake the supervisor must report `starting`, not `no-worker`.
    expect(h.supervisor.status(1).state).toBe("starting");

    h.links[0]?.sendReady();
    const [a, b] = await Promise.all(callers);

    expect(a).toBe(b);
    expect(a.state).toBe("running");
    expect(h.links).toHaveLength(1);
    await h.supervisor.stopAll();
  });

  test("refuses a deleted domain and reaps its worker, without waiting for the tick", async () => {
    // Review finding: the cache was consulted before the registry, so ensure()
    // handed back a live worker bound to the old path for a domain with no row,
    // and status() agreed it was `running`. Unbounded for any caller holding the
    // returned server — for #3044 that is project code running against a
    // deleted project's path.
    const h = makeSupervisor([domain(1, "phoenix")]);
    await h.supervisor.ensure(1);
    expect(h.supervisor.workerCount).toBe(1);

    h.registry.replace([]);

    await expect(h.supervisor.ensure(1)).rejects.toThrow(UnknownDomainError);
    expect(h.supervisor.workerCount).toBe(0);
    expect(h.supervisor.status(1)).toEqual({ state: "no-such-domain", domainId: 1 });
    await pollUntil(() => h.linksFor(1)[0]?.isClosed === true);
  });

  test("refuses a domain that moved to another host and reaps its worker", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    await h.supervisor.ensure(1);

    h.registry.replace([domain(1, "phoenix", { host: "boxen0010" })]);

    await expect(h.supervisor.ensure(1)).rejects.toThrow(RemoteDomainError);
    expect(h.supervisor.workerCount).toBe(0);
  });

  test("replaces rather than reuses a worker whose domain moved", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    const first = await h.supervisor.ensure(1);

    h.registry.replace([domain(1, "phoenix", { path: "/projects/moved" })]);
    const second = await h.supervisor.ensure(1);

    expect(second).not.toBe(first);
    expect(second.domain.path).toBe("/projects/moved");
    await h.supervisor.stopAll();
  });

  test("throws UnknownDomainError for a domain that was never registered", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    await expect(h.supervisor.ensure(42)).rejects.toThrow(UnknownDomainError);
    await expect(h.supervisor.ensureByName("nope")).rejects.toThrow(/mcx domain add/);
  });

  test("throws RemoteDomainError rather than running another host's project here", async () => {
    const h = makeSupervisor([domain(1, "phoenix", { host: "boxen0010" })]);
    await expect(h.supervisor.ensure(1)).rejects.toThrow(RemoteDomainError);
    expect(h.links).toHaveLength(0);
  });

  test("ensureByName resolves through the table", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);

    const server = await h.supervisor.ensureByName("clrg");

    expect(server.domain.id).toBe(2);
    await h.supervisor.stopAll();
  });

  test("a failed start leaves no worker behind", async () => {
    // Every worker answers the handshake with the wrong domain id.
    const h = makeSupervisor([domain(1, "phoenix")], { readyOverrides: { domain_id: 999 } });

    await expect(h.supervisor.ensure(1)).rejects.toThrow(/identity mismatch/);
    expect(h.supervisor.workerCount).toBe(0);
    expect(h.supervisor.status(1).state).toBe("no-worker");
  });
});

describe("DomainSupervisor.status", () => {
  test("distinguishes a domain that does not exist from a worker that is coming back", async () => {
    // The whole reason the return type is a union: a caller that conflates these
    // retries forever against a domain that was deleted.
    const h = makeSupervisor([domain(1, "phoenix")]);
    const missing: DomainWorkerStatus = h.supervisor.status(42);
    expect(missing).toEqual({ state: "no-such-domain", domainId: 42 });
    expect(isTransientStatus(missing)).toBe(false);

    await h.supervisor.ensure(1);
    expect(h.supervisor.status(1)).toEqual({ state: "running", domain: expect.objectContaining({ name: "phoenix" }) });

    h.linksFor(1)[0]?.die("worker panicked");
    await pollUntil(() => h.supervisor.status(1).state === "running" && h.linksFor(1).length === 2);
    await h.supervisor.stopAll();
  });

  test("a registered domain with no worker is 'no-worker', not an error", async () => {
    // Lazy spawn means "registered" and "running" are different facts, exactly
    // as the domains table has no state column.
    const h = makeSupervisor([domain(1, "phoenix")]);
    const status = h.supervisor.status(1);
    expect(status.state).toBe("no-worker");
    expect(isTransientStatus(status)).toBe(true);
    expect(h.links).toHaveLength(0);
  });

  test("lists every registered domain whether or not it has a worker", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);
    await h.supervisor.ensure(1);

    const byName = new Map(h.supervisor.list().map((s) => ["domain" in s ? s.domain.name : "?", s.state]));

    expect(byName.get("phoenix")).toBe("running");
    expect(byName.get("clrg")).toBe("no-worker");
    await h.supervisor.stopAll();
  });
});

describe("DomainSupervisor.sync", () => {
  test("a domain removed loses its worker", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);
    await h.supervisor.ensure(1);
    await h.supervisor.ensure(2);

    h.registry.replace([domain(2, "clrg")]);
    h.supervisor.sync();

    expect(h.supervisor.workerCount).toBe(1);
    expect(h.supervisor.status(1)).toEqual({ state: "no-such-domain", domainId: 1 });
    // The surviving domain is untouched — that is the blast-radius property.
    expect(h.supervisor.status(2).state).toBe("running");
    await pollUntil(() => h.linksFor(1)[0]?.isClosed === true);
    expect(h.linksFor(2)[0]?.isClosed).toBe(false);
    await h.supervisor.stopAll();
  });

  test("a domain that moved loses its worker, and the next use starts a fresh one", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    await h.supervisor.ensure(1);

    h.registry.replace([domain(1, "phoenix", { path: "/projects/phoenix-2" })]);
    h.supervisor.sync();
    expect(h.supervisor.workerCount).toBe(0);

    const restarted = await h.supervisor.ensure(1);

    expect(restarted.domain.path).toBe("/projects/phoenix-2");
    expect(h.linksFor(1)).toHaveLength(2);
    await h.supervisor.stopAll();
  });

  test("a rename keeps the worker running and updates the supervisor's view", async () => {
    // A worker is bound to host + path + id; a rename changes none of them.
    // Dropping it here silently killed a worker on `mcx domain rename`, and once
    // #3044 moves project execution into it that aborts a running phase for a
    // cosmetic edit.
    const h = makeSupervisor([domain(1, "phoenix")]);
    const server = await h.supervisor.ensure(1);
    const linksBefore = h.linksFor(1).length;

    h.registry.replace([{ ...domain(1, "phoenix"), name: "phoenix2" }]);
    h.supervisor.sync();

    expect(server.state).toBe("running");
    expect(h.linksFor(1)).toHaveLength(linksBefore);
    expect(h.linksFor(1)[0]?.isClosed).toBe(false);
    // The supervisor's view follows the table, so status() reports the new name.
    expect(server.domain.name).toBe("phoenix2");
    expect(h.supervisor.status(1)).toEqual({ state: "running", domain: expect.objectContaining({ name: "phoenix2" }) });
    // Same worker, not a replacement.
    expect(await h.supervisor.ensure(1)).toBe(server);
    await h.supervisor.stopAll();
  });

  test("a move restarts the worker even when the name is unchanged", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    await h.supervisor.ensure(1);

    h.registry.replace([domain(1, "phoenix", { path: "/projects/phoenix-moved" })]);
    h.supervisor.sync();

    expect(h.supervisor.workerCount).toBe(0);
    const restarted = await h.supervisor.ensure(1);
    expect(restarted.domain.path).toBe("/projects/phoenix-moved");
    expect(h.linksFor(1)).toHaveLength(2);
    await h.supervisor.stopAll();
  });

  test("a domain that gains a host restarts rather than being adopted", async () => {
    // A rename is free; acquiring a host is not — the worker for it runs there.
    const h = makeSupervisor([domain(1, "phoenix")]);
    await h.supervisor.ensure(1);

    h.registry.replace([domain(1, "phoenix", { host: "boxen0010" })]);
    h.supervisor.sync();

    expect(h.supervisor.workerCount).toBe(0);
    await expect(h.supervisor.ensure(1)).rejects.toThrow(RemoteDomainError);
  });

  test("does nothing, and touches no rows, when no worker is running", () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    let reads = 0;
    const counting: DomainRegistry = {
      getDomainById: (id) => {
        reads++;
        return h.registry.getDomainById(id);
      },
      getDomainByName: (n) => h.registry.getDomainByName(n),
      listDomains: () => h.registry.listDomains(),
    };
    const idle = new DomainSupervisor({ registry: counting, logger: silentLogger });

    idle.sync();

    expect(reads).toBe(0);
  });

  test("drops a permanently failed worker so the next use gets a clean attempt", async () => {
    const h = makeSupervisor([domain(1, "phoenix")]);
    const server = await h.supervisor.ensure(1);

    for (let i = 0; i <= FAST_POLICY.maxCrashes; i++) {
      const before = h.linksFor(1).length;
      h.linksFor(1).at(-1)?.die(`crash ${i}`);
      if (i < FAST_POLICY.maxCrashes) await pollUntil(() => h.linksFor(1).length > before);
    }
    await pollUntil(() => server.state === "failed");
    expect(h.supervisor.status(1).state).toBe("failed");

    h.supervisor.sync();

    expect(h.supervisor.workerCount).toBe(0);
    const fresh = await h.supervisor.ensure(1);
    expect(fresh).not.toBe(server);
    expect(fresh.state).toBe("running");
    await h.supervisor.stopAll();
  });
});

describe("DomainSupervisor.stopAll", () => {
  test("stops every worker and refuses to start more", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);
    await h.supervisor.ensure(1);
    await h.supervisor.ensure(2);

    await h.supervisor.stopAll();

    expect(h.supervisor.workerCount).toBe(0);
    expect(h.links.every((l) => l.isClosed)).toBe(true);
    await expect(h.supervisor.ensure(1)).rejects.toThrow(SupervisorStoppedError);
  });

  test("one worker failing to stop does not strand the others", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);
    const first = await h.supervisor.ensure(1);
    await h.supervisor.ensure(2);
    (first as unknown as { stop: () => Promise<void> }).stop = () => Promise.reject(new Error("wedged"));

    await h.supervisor.stopAll();

    expect(h.supervisor.workerCount).toBe(0);
    expect(h.linksFor(2)[0]?.isClosed).toBe(true);
  });

  test("stopDomain stops one domain and leaves the rest alone", async () => {
    const h = makeSupervisor([domain(1, "phoenix"), domain(2, "clrg")]);
    await h.supervisor.ensure(1);
    await h.supervisor.ensure(2);

    await h.supervisor.stopDomain(1);

    expect(h.linksFor(1)[0]?.isClosed).toBe(true);
    expect(h.supervisor.status(2).state).toBe("running");
    await h.supervisor.stopAll();
  });
});
