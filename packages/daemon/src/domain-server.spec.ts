import { describe, expect, test } from "bun:test";
import { type DomainSnapshot, ProtocolVersionMismatchError, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import {
  DOMAIN_HANDSHAKE_TIMEOUT_MS,
  DomainServer,
  type DomainServerOptions,
  DomainWorkerUnavailableError,
  RemoteDomainError,
} from "./domain-server";
import type { RestartPolicy } from "./restart-policy";
import {
  type FakeDomainLink,
  type FakeDomainLinkOptions,
  makeFakeDomainLink,
  makeStubDomainClient,
} from "./test-helpers";

const phoenix: DomainSnapshot = {
  id: 1,
  name: "phoenix",
  host: null,
  path: "/projects/phoenix",
  createdAt: "2026-08-22T00:00:00Z",
};

/** Backoff with no wall-clock cost: what is under test is the attempt count, not the milliseconds. */
const FAST_POLICY: RestartPolicy = { maxCrashes: 3, crashWindowMs: 60_000, backoffDelaysMs: [0, 0, 0] };

/** Wide enough that "is it restarting right now?" is observable without racing a stopwatch. */
const SLOW_HANDSHAKE_MS = 1000;

interface Harness {
  server: DomainServer;
  links: FakeDomainLink[];
  latest: () => FakeDomainLink;
  gone: () => boolean;
  failures: string[];
}

interface HarnessOptions extends Partial<DomainServerOptions> {
  initial?: DomainSnapshot;
  linkOptions?: FakeDomainLinkOptions;
}

function makeServer(options: HarnessOptions = {}): Harness {
  const { initial, linkOptions, ...serverOverrides } = options;
  const links: FakeDomainLink[] = [];
  const failures: string[] = [];
  let goneCalled = false;

  const server = new DomainServer(initial ?? phoenix, {
    linkFactory: (domain) => {
      const link = makeFakeDomainLink(domain, linkOptions);
      links.push(link);
      return link;
    },
    resolveDomain: () => phoenix,
    clientFactory: () => makeStubDomainClient(),
    logger: silentLogger,
    restartPolicy: FAST_POLICY,
    onGone: () => {
      goneCalled = true;
    },
    onPermanentlyFailed: (reason) => failures.push(reason),
    ...serverOverrides,
  });

  return {
    server,
    links,
    latest: () => {
      const link = links.at(-1);
      if (!link) throw new Error("no link was created");
      return link;
    },
    gone: () => goneCalled,
    failures,
  };
}

/** Start a server whose links answer `ready` only when told to. */
async function startManually(h: Harness): Promise<void> {
  const started = h.server.start();
  await pollUntil(() => h.links.length === 1);
  h.latest().sendReady();
  await started;
}

describe("DomainServer.start", () => {
  test("sends init, waits for ready, and reports running", async () => {
    const h = makeServer();
    expect(h.server.state).toBe("stopped");

    await h.server.start();

    expect(h.server.state).toBe("running");
    expect(h.latest().sent).toHaveLength(1);
    expect(h.latest().sent[0]?.type).toBe("init");
    expect(h.latest().sent[0]?.domain).toEqual(phoenix);
    await h.server.stop();
  });

  test("refuses a domain that lives on another host", () => {
    // Not a state to retry out of: a worker here can never serve a domain there.
    expect(() => makeServer({ initial: { ...phoenix, host: "boxen0010" } })).toThrow(RemoteDomainError);
  });

  test("fails when the worker reports an init error", async () => {
    const h = makeServer({ linkOptions: { autoReady: false } });
    const started = h.server.start();
    await pollUntil(() => h.links.length === 1);
    h.latest().sendError("could not seal HTTP");

    await expect(started).rejects.toThrow(/could not seal HTTP/);
    expect(h.server.state).toBe("failed");
    expect(h.latest().isClosed).toBe(true);
  });

  test("fails when the worker bound a different domain", async () => {
    const h = makeServer({ linkOptions: { readyOverrides: { domain_id: 99 } } });
    await expect(h.server.start()).rejects.toThrow(/identity mismatch/);
    expect(h.server.state).toBe("failed");
  });

  test("fails on a protocol version mismatch", async () => {
    const h = makeServer({ linkOptions: { readyOverrides: { supported_protocol_version: 99 } } });
    await expect(h.server.start()).rejects.toThrow(ProtocolVersionMismatchError);
  });

  test("fails when the link dies during the handshake", async () => {
    const h = makeServer({ linkOptions: { autoReady: false } });
    const started = h.server.start();
    await pollUntil(() => h.links.length === 1);
    h.latest().die("worker exited before ready");

    await expect(started).rejects.toThrow(/worker exited before ready/);
    expect(h.server.state).toBe("failed");
  });

  test("times out a worker that never answers", async () => {
    const h = makeServer({ linkOptions: { autoReady: false }, handshakeTimeoutMs: 5 });

    await expect(h.server.start()).rejects.toThrow(/startup timeout/);
    expect(h.server.state).toBe("failed");
    expect(h.latest().isClosed).toBe(true);
  });

  test("has a bounded handshake budget rather than waiting forever", () => {
    expect(DOMAIN_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("DomainServer.call", () => {
  test("rejects with a retryable error while the worker is not running", async () => {
    const h = makeServer();
    const err = (await h.server.call("domain_ping").catch((e: unknown) => e)) as DomainWorkerUnavailableError;

    expect(err).toBeInstanceOf(DomainWorkerUnavailableError);
    expect(err.state).toBe("stopped");
    // The distinction a caller needs, as a field and not as a sentence.
    expect(err.retryable).toBe(true);
  });

  test("passes the tool through once running", async () => {
    const calls: string[] = [];
    const h = makeServer({
      clientFactory: () =>
        makeStubDomainClient({
          callTool: async ({ name }) => {
            calls.push(name);
            return { content: [{ type: "text", text: "pong" }] };
          },
        }),
    });
    await h.server.start();

    await h.server.call("domain_ping");

    expect(calls).toEqual(["domain_ping"]);
    await h.server.stop();
  });

  test("a request in flight when the worker dies is rejected, not abandoned", async () => {
    // A promise that never settles is worse than an error: the caller cannot
    // distinguish a slow domain from a dead one. The MCP client rejects pending
    // requests when its transport closes; the stub stands in for that so what
    // is under test is the supervisor actually closing the client.
    let rejectInFlight: ((err: Error) => void) | undefined;
    const h = makeServer({
      clientFactory: () =>
        makeStubDomainClient({
          callTool: () =>
            new Promise((_, reject) => {
              rejectInFlight = reject;
            }),
          close: async () => rejectInFlight?.(new Error("connection closed")),
        }),
    });
    await h.server.start();
    const inFlight = h.server.call("domain_ping");
    await pollUntil(() => rejectInFlight !== undefined);

    h.latest().die("worker panicked");

    await expect(inFlight).rejects.toThrow(/connection closed/);
    await h.server.stop();
  });
});

describe("DomainServer crash handling", () => {
  test("restarts a dead worker and comes back running", async () => {
    const h = makeServer();
    await h.server.start();

    h.latest().die("worker panicked");

    await pollUntil(() => h.server.state === "running" && h.links.length === 2);
    expect(h.links[0]?.isClosed).toBe(true);
    await h.server.stop();
  });

  test("re-reads the domain row on restart instead of replaying its snapshot", async () => {
    // A rename or a move while the worker was down must reach the new worker.
    // Nothing the worker held in memory survives; the table is the truth.
    const moved: DomainSnapshot = { ...phoenix, name: "phoenix2", path: "/projects/phoenix2" };
    let current: DomainSnapshot = phoenix;
    const h = makeServer({ resolveDomain: () => current });
    await h.server.start();

    current = moved;
    h.latest().die("worker panicked");
    await pollUntil(() => h.server.state === "running");

    expect(h.server.domain).toEqual(moved);
    expect(h.latest().sent[0]?.domain).toEqual(moved);
    await h.server.stop();
  });

  test("does not restart a worker whose domain was deleted", async () => {
    let exists = true;
    const h = makeServer({ resolveDomain: () => (exists ? phoenix : null) });
    await h.server.start();

    exists = false;
    h.latest().die("worker panicked");

    await pollUntil(() => h.server.state === "gone");
    expect(h.gone()).toBe(true);
    expect(h.links).toHaveLength(1);
  });

  test("does not restart a worker whose domain moved to another host", async () => {
    let current: DomainSnapshot = phoenix;
    const h = makeServer({ resolveDomain: () => current });
    await h.server.start();

    current = { ...phoenix, host: "boxen0010" };
    h.latest().die("worker panicked");

    await pollUntil(() => h.server.state === "gone");
    expect(h.links).toHaveLength(1);
  });

  test("gives up after the crash budget, and says so exactly once", async () => {
    const h = makeServer();
    await h.server.start();

    for (let i = 0; i <= FAST_POLICY.maxCrashes; i++) {
      const before = h.links.length;
      h.latest().die(`crash ${i}`);
      if (i < FAST_POLICY.maxCrashes) {
        await pollUntil(() => h.links.length > before && h.server.state === "running");
      }
    }

    await pollUntil(() => h.server.state === "failed");
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain("giving up auto-restart");
    // A worker that gave up is not retryable — a caller must stop hammering it.
    const err = (await h.server.call("domain_ping").catch((e: unknown) => e)) as DomainWorkerUnavailableError;
    expect(err.retryable).toBe(false);
  });

  test("reports restarting, not failed, while a restart is under way", async () => {
    // A caller that reads `failed` mid-backoff concludes the worker is never
    // coming back and stops retrying a domain that is about to be healthy.
    const h = makeServer({ linkOptions: { autoReady: false }, handshakeTimeoutMs: SLOW_HANDSHAKE_MS });
    await startManually(h);

    h.latest().die("worker panicked");
    await pollUntil(() => h.links.length === 2);

    expect(h.server.state).toBe("restarting");

    h.latest().sendReady();
    await pollUntil(() => h.server.state === "running");
    await h.server.stop();
  });

  test("a second crash during a restart does not start two workers", async () => {
    const h = makeServer({ linkOptions: { autoReady: false }, handshakeTimeoutMs: SLOW_HANDSHAKE_MS });
    await startManually(h);

    const first = h.latest();
    first.die("crash a");
    first.die("crash b");
    await pollUntil(() => h.links.length === 2);
    h.latest().sendReady();
    await pollUntil(() => h.server.state === "running");

    expect(h.links).toHaveLength(2);
    await h.server.stop();
  });
});

describe("DomainServer.stop", () => {
  test("closes the link and is idempotent", async () => {
    const h = makeServer();
    await h.server.start();

    await h.server.stop();
    await h.server.stop();

    expect(h.latest().isClosed).toBe(true);
    expect(h.server.state).toBe("stopped");
  });

  test("a worker that dies after stop is not restarted", async () => {
    const h = makeServer();
    await h.server.start();
    const link = h.latest();
    await h.server.stop();

    link.die("late death");

    // stop() detached the failure handler, so this is settled synchronously —
    // no waiting on the absence of an event.
    expect(h.links).toHaveLength(1);
    expect(h.server.state).toBe("stopped");
  });
});
