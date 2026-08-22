/**
 * End-to-end against real Bun Workers: the handshake, the tools, the isolation
 * between two domains, the no-HTTP guard, and a real worker death reaching the
 * supervisor. Everything about *decisions* under crash (backoff, budgets,
 * reaping) is in `domain-server.spec.ts` / `domain-supervisor.spec.ts`, which
 * spawn nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type DomainSnapshot, domainInitMessage, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import { createWorkerDomainLink } from "./domain-link";
import { DomainServer } from "./domain-server";
import type { RestartPolicy } from "./restart-policy";

const FAST_POLICY: RestartPolicy = { maxCrashes: 2, crashWindowMs: 60_000, backoffDelaysMs: [0, 0] };

const CRASHING_WORKER = resolve(import.meta.dir, "../../../test/crashing-domain-worker.ts");

function snapshot(id: number, name: string): DomainSnapshot {
  return { id, name, host: null, path: `/projects/${name}`, createdAt: "2026-08-22T00:00:00Z" };
}

const started: DomainServer[] = [];

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
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

describe("a real domain worker", () => {
  // Assertions are grouped per spawned worker rather than one test each: a real
  // Worker boot is ~400ms, and this file has a 5s isolation budget to keep.
  test("binds its domain, serves no HTTP, and answers its lifecycle tools", async () => {
    const phoenix = snapshot(1, "phoenix");
    const server = makeServer(phoenix);
    await server.start();

    const info = payload(await server.call("domain_info"));
    const pong = payload(await server.call("domain_ping"));
    const unknown = (await server.call("domain_run_everything")) as { isError?: boolean };

    expect(info.domain).toEqual(phoenix);
    expect(info.protocolVersion).toBe(1);
    // Reported by the worker itself rather than asserted about its source: the
    // guard is a property of the running process, and a Bun upgrade that broke
    // the seal would show up right here.
    expect(info.guards).toEqual({ http: "sealed" });
    expect(pong).toMatchObject({ ok: true, domainId: 1 });
    expect(unknown.isError).toBe(true);
  });

  test("two domains get two workers, each resolving its own domain row", async () => {
    // The acceptance criterion of #3043, against real threads.
    const phoenix = snapshot(1, "phoenix");
    const clrg = snapshot(2, "clrg");
    const a = makeServer(phoenix);
    const b = makeServer(clrg);

    await Promise.all([a.start(), b.start()]);
    const [infoA, infoB] = [payload(await a.call("domain_info")), payload(await b.call("domain_info"))];

    expect(infoA.domain).toEqual(phoenix);
    expect(infoB.domain).toEqual(clrg);
    // Stopping one leaves the other serving — the blast-radius property, in the
    // smallest form this issue can prove it (#3045 proves it under a crash).
    await b.stop();
    expect(payload(await a.call("domain_info")).domain).toEqual(phoenix);
  });

  test("refuses an init that binds it to a domain on another host", async () => {
    // Defence in depth: the supervisor refuses this too, but the worker must not
    // rely on being asked politely — over a socket the init comes from the wire.
    const remote: DomainSnapshot = { ...snapshot(3, "phoenix"), host: "boxen0010" };
    const link = createWorkerDomainLink(remote);
    const messages: Array<{ type: string; message?: string }> = [];
    link.onControl = (m) => messages.push(m);

    link.postControl(domainInitMessage(remote, null));
    await pollUntil(() => messages.length > 0);

    expect(messages[0]?.type).toBe("error");
    expect(messages[0]?.message).toMatch(/cannot be served by a worker in this process/);
    await link.close();
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
