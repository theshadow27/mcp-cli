/**
 * Supervision against real Bun Workers: a worker that crashes, a worker that
 * exits cleanly, and the supervisor driving both through a real `WorkerDomainLink`.
 *
 * Split from `domain-worker.spec.ts` because these run the restart policy to
 * exhaustion and therefore boot several real workers each. Keeping them beside
 * the handshake tests pushed one file toward the 5s isolation budget, which is
 * the shape behind the near-end SIGTERM in #2644 on a contended runner.
 *
 * Decisions under crash — backoff, budgets, reaping — are covered without
 * threads in `domain-server.spec.ts` / `domain-supervisor.spec.ts`. What these
 * prove is the plumbing underneath them: that a real thread's death arrives at
 * all, by the event the runtime actually fires.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Domain, type DomainSnapshot, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import { createWorkerDomainLink } from "./domain-link";
import { DomainServer } from "./domain-server";
import { DomainSupervisor, UnknownDomainError } from "./domain-supervisor";
import type { RestartPolicy } from "./restart-policy";

const FAST_POLICY: RestartPolicy = { maxCrashes: 2, crashWindowMs: 60_000, backoffDelaysMs: [0, 0] };

const CRASHING_WORKER = resolve(import.meta.dir, "../../../test/crashing-domain-worker.ts");
const EXITING_WORKER = resolve(import.meta.dir, "../../../test/exiting-domain-worker.ts");

function snapshot(id: number, name: string): DomainSnapshot {
  return { id, name, host: null, path: `/projects/${name}`, createdAt: "2026-08-22T00:00:00Z" };
}

const started: DomainServer[] = [];
const supervisors: DomainSupervisor[] = [];

function makeServer(
  domain: DomainSnapshot,
  extra?: { workerScript?: string; onPermanentlyFailed?: (reason: string) => void },
): DomainServer {
  const workerScript = extra?.workerScript;
  const server = new DomainServer(domain, {
    linkFactory: (d) =>
      workerScript ? createWorkerDomainLink(d, () => new Worker(workerScript)) : createWorkerDomainLink(d),
    resolveDomain: () => domain,
    logger: silentLogger,
    restartPolicy: FAST_POLICY,
    onPermanentlyFailed: extra?.onPermanentlyFailed,
  });
  started.push(server);
  return server;
}

/** Read a tool result's JSON payload. */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`tool result had no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

describe("the supervisor against real workers", () => {
  // Review finding 13: `DomainSupervisor` was tested entirely against fakes and
  // `domain-worker.spec.ts` built `DomainServer` directly, so the seam where the
  // ensure()/stop() findings live had no coverage by construction.
  test("two domains get two real workers, and a deleted one is refused and reaped", async () => {
    const rows: Domain[] = [
      { id: 1, name: "phoenix", host: null, path: "/projects/phoenix", createdAt: "2026-08-22T00:00:00Z" },
      { id: 2, name: "clrg", host: null, path: "/projects/clrg", createdAt: "2026-08-22T00:00:00Z" },
    ];
    let live = [...rows];
    const supervisor = new DomainSupervisor({
      registry: {
        getDomainById: (id) => live.find((r) => r.id === id) ?? null,
        getDomainByName: (name) => live.find((r) => r.name === name) ?? null,
        listDomains: () => [...live],
      },
      logger: silentLogger,
      restartPolicy: FAST_POLICY,
    });
    supervisors.push(supervisor);

    const [a, b] = await Promise.all([supervisor.ensure(1), supervisor.ensure(2)]);
    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(payload(await a.call("domain_info")).domain).toMatchObject({ id: 1, name: "phoenix" });
    expect(payload(await b.call("domain_info")).domain).toMatchObject({ id: 2, name: "clrg" });

    live = live.filter((r) => r.id !== 1);
    await expect(supervisor.ensure(1)).rejects.toThrow(UnknownDomainError);

    // The surviving domain is untouched — one domain's removal is one domain's
    // blast radius.
    expect(supervisor.status(2).state).toBe("running");
    expect(payload(await b.call("domain_ping")).domainId).toBe(2);
  });
});

describe("a real domain worker that exits cleanly", () => {
  test("is detected and restarted — `running` must not mean `we have not heard it die`", async () => {
    // The review's finding: the link wired `onmessage` and `onerror` but no exit
    // path, and a worker calling process.exit() fires `close`, not `error`. The
    // supervisor therefore reported `running` forever, `call()` sailed past its
    // fail-fast gate, and only a daemon restart cleared it.
    const failures: string[] = [];
    const server = makeServer(snapshot(1, "phoenix"), {
      workerScript: EXITING_WORKER,
      onPermanentlyFailed: (reason) => failures.push(reason),
    });

    await server.start();
    expect(server.state).toBe("running");

    // Every restart exits the same way, so the policy runs to exhaustion. What
    // is under test is that the exit registers at all.
    await pollUntil(() => server.state === "failed", 4000);
    expect(server.crashCount).toBeGreaterThan(FAST_POLICY.maxCrashes);
    expect(failures[0]).toContain("giving up auto-restart");
  });
});

describe("a real domain worker that dies", () => {
  test("reaches the supervisor, is restarted, and eventually gives up", async () => {
    // The half the fake link cannot prove: that an actual Bun Worker death
    // arrives as a link failure at all.
    const failures: string[] = [];
    const server = makeServer(snapshot(1, "phoenix"), {
      workerScript: CRASHING_WORKER,
      onPermanentlyFailed: (reason) => failures.push(reason),
    });

    await server.start();
    expect(server.state).toBe("running");

    await pollUntil(() => server.state === "failed", 4000);
    expect(server.crashCount).toBeGreaterThan(FAST_POLICY.maxCrashes);
    expect(failures[0]).toContain("giving up auto-restart");
  });
});
