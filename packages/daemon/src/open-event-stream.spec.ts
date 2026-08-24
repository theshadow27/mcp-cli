/**
 * Integration tests for openEventStream() (client-side).
 *
 * Tests the client against a real IpcServer + EventBus, verifying the full
 * NDJSON framing path. Covers the four cases deferred from PR #1519 (issue #1527):
 *   1. NDJSON framing works end-to-end
 *   2. abort() stops iteration cleanly
 *   3. ?since=N query param is forwarded correctly
 *   4. Malformed lines are skipped without breaking the iterator
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, openEventStream, options, silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import { IpcServer } from "./ipc-server";

function tmpSocket(): string {
  return join(tmpdir(), `mcp-oes-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function mockPool() {
  return {
    listServers: () => [],
    listTools: () => [],
    getToolInfo: () => null,
    grepTools: () => [],
    callTool: async () => ({ content: [] }),
    getServerUrl: () => null,
    getDb: () => null,
    restart: async () => {},
    getStderrLines: () => [],
    subscribeStderr: () => () => {},
  };
}

function mockDb() {
  return {
    recordUsage: () => {},
    recordSpan: () => {},
    getUsageStats: () => [],
    getSpans: () => [],
    markSpansExported: () => {},
    pruneSpans: () => 0,
    listAliases: () => [],
    getAlias: () => null,
    saveAlias: () => {},
    deleteAlias: () => {},
    touchAliasExpiry: () => {},
    pruneExpiredAliases: () => 0,
    getServerLogs: () => [],
    getCachedTools: () => [],
    listSessions: () => [],
    getDatabase: () => new Database(":memory:"),
  } as never;
}

function mockConfig() {
  return { servers: new Map(), sources: [] } as never;
}

function startOpts() {
  return {
    daemonId: "test-daemon-oes",
    startedAt: Date.now(),
    onActivity: () => {},
    logger: silentLogger,
  };
}

/**
 * Consume the iterator until we find an event matching the predicate,
 * then abort and return it.
 */
async function collectUntil(
  stream: ReturnType<typeof openEventStream>,
  predicate: (e: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for await (const event of stream.events) {
    if (predicate(event as Record<string, unknown>)) {
      stream.abort();
      return event as Record<string, unknown>;
    }
    if (Date.now() > deadline) break;
  }
  stream.abort();
  throw new Error(`collectUntil: predicate not satisfied within ${timeoutMs}ms`);
}

describe("openEventStream() client integration", () => {
  let server: IpcServer | undefined;
  let socketPath: string;

  afterEach(() => {
    server?.stop();
    server = undefined;
    _restoreOptions();
    try {
      unlinkSync(socketPath);
      // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
    } catch {
      /* already cleaned up */
    }
  });

  function startServerWithBus(): { bus: EventBus } {
    const bus = new EventBus();
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
      ...startOpts(),
      eventBus: bus,
    });
    server.start(socketPath);
    options.SOCKET_PATH = socketPath;
    return { bus };
  }

  test("NDJSON framing works end-to-end through openEventStream()", async () => {
    const { bus } = startServerWithBus();

    const stream = openEventStream();

    // Publish after a microtask so the stream is open and ready to receive.
    // We poll until the event arrives rather than using a fixed sleep.
    let received: Record<string, unknown> | undefined;
    const consuming = (async () => {
      for await (const event of stream.events) {
        const e = event as Record<string, unknown>;
        if (e.event === "session.result") {
          received = e;
          stream.abort();
          return;
        }
      }
    })();

    // Wait for the stream to open (connection confirmed line arrives), then publish.
    await pollUntil(() => {
      bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s1", cost: 2.5 });
      return received !== undefined;
    }, 2_000);

    await consuming;

    expect(received).toBeDefined();
    expect(received?.event).toBe("session.result");
    expect(received?.category).toBe("session");
    expect(received?.sessionId).toBe("s1");
    expect(typeof received?.seq).toBe("number");
    expect(typeof received?.ts).toBe("string");
  });

  test("real client sees the EventBus-branch heartbeat as a parseable MonitorEvent (#3243)", async () => {
    // End-to-end regression for #3243: production's /events heartbeat used to be a
    // bare "\n" that openEventStream()'s NDJSON parser (packages/core/src/ipc-client.ts)
    // silently dropped as a blank line — so `mcx monitor`'s liveness watchdog never
    // reset on transport liveness alone, only on real business events. This exercises
    // the actual client parser (unmodified — no client-side change was needed once the
    // daemon emits a real event) against the actual daemon heartbeat emission path.
    startServerWithBus();

    const capturedIntervalFns: Array<{ fn: () => void; ms: number }> = [];
    const origSetInterval = globalThis.setInterval;
    (globalThis as unknown as Record<string, unknown>).setInterval = (fn: (...args: unknown[]) => void, ms: number) => {
      capturedIntervalFns.push({ fn: fn as () => void, ms });
      return origSetInterval(fn, ms);
    };

    try {
      const stream = openEventStream();

      let received: Record<string, unknown> | undefined;
      const consuming = (async () => {
        for await (const event of stream.events) {
          const e = event as Record<string, unknown>;
          if (e.category === "heartbeat") {
            received = e;
            stream.abort();
            return;
          }
        }
      })();

      // Wait for the client's fetch to actually connect (registering the daemon-side
      // setInterval), then fire the 15s heartbeat manually — never wait real time.
      await pollUntil(() => capturedIntervalFns.some((c) => c.ms === 15_000), 2_000);
      const hbInterval = capturedIntervalFns.find((c) => c.ms === 15_000);
      hbInterval?.fn();

      await consuming;

      expect(received).toBeDefined();
      expect(received?.event).toBe("heartbeat");
      expect(received?.category).toBe("heartbeat");
      expect(received?.src).toBe("daemon");
      expect(typeof received?.seq).toBe("number");
      expect(typeof received?.ts).toBe("string");
    } finally {
      (globalThis as unknown as Record<string, unknown>).setInterval = origSetInterval;
    }
  });

  test("abort() stops iteration cleanly with no dangling async iterators", async () => {
    startServerWithBus();

    const stream = openEventStream();
    // Abort before any iteration begins — the signal is already set when fetch() is
    // called, so the generator must end iteration immediately *and cleanly*: an abort
    // we initiated ourselves is an end-of-stream, not an error the consumer has to
    // catch (#2985).
    stream.abort();

    let eventCount = 0;
    const consumed = (async () => {
      for await (const _event of stream.events) {
        // Should never reach here — abort was called before iteration
        eventCount++;
      }
      return "iteration-ended";
    })();

    // Must *resolve*, not reject: the consumer never has to catch its own abort,
    // and the iterator must not be left dangling.
    await expect(consumed).resolves.toBe("iteration-ended");
    expect(eventCount).toBe(0);
  });

  test("a non-abort stream error still propagates to the consumer", async () => {
    // The abort-absorbing catch in openEventStream() must not swallow real failures.
    // Point the client at a server that answers /events with a 500.
    const errSocket = tmpSocket();
    const errServer = Bun.serve({
      unix: errSocket,
      fetch: () => new Response("boom", { status: 500 }),
    });
    options.SOCKET_PATH = errSocket;

    try {
      const stream = openEventStream();
      const consume = (async () => {
        for await (const _event of stream.events) {
          /* no events expected */
        }
      })();
      await expect(consume).rejects.toThrow(/Event stream error: 500/);
    } finally {
      errServer.stop(true);
      try {
        unlinkSync(errSocket);
        // dotw-ignore test-empty-catch: best-effort cleanup — file may already be gone
      } catch {
        /* already cleaned up */
      }
    }
  });

  test("?since=N query param is forwarded correctly in the request URL", async () => {
    const db = new Database(":memory:");
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
      ...startOpts(),
      eventBus: bus,
    });
    server.start(socketPath);
    options.SOCKET_PATH = socketPath;

    // Publish two events before any client connects — persisted to the durable log.
    bus.publish({ src: "test", event: "session.result", category: "session", sessionId: "s-hist-1" });
    bus.publish({ src: "test", event: "pr.merged", category: "work_item", prNumber: 7 });

    // Connect with since=0 — should receive both historical events as backfill.
    // This proves the ?since=0 param was forwarded in the request URL.
    const stream = openEventStream({ since: 0 });

    const events: Record<string, unknown>[] = [];
    const deadline = Date.now() + 2_000;
    for await (const event of stream.events) {
      const e = event as Record<string, unknown>;
      if (e.event === "session.result" || e.event === "pr.merged") {
        events.push(e);
      }
      if (events.length >= 2 || Date.now() > deadline) {
        stream.abort();
        break;
      }
    }

    expect(events.length).toBe(2);
    expect(events[0]?.event).toBe("session.result");
    expect(events[1]?.event).toBe("pr.merged");
    // seq numbers must be ascending
    expect(events[0]?.seq as number).toBeLessThan(events[1]?.seq as number);
  });

  test("malformed line in server response is skipped without breaking the iterator", async () => {
    // Use a minimal Bun.serve on a Unix socket to inject a malformed NDJSON line
    // followed by a valid event. This validates the client-side error handling.
    const malformSocket = tmpSocket();

    const encoder = new TextEncoder();
    const malformServer = Bun.serve({
      unix: malformSocket,
      fetch() {
        const body = new ReadableStream({
          start(controller) {
            // malformed line first
            controller.enqueue(encoder.encode("not-valid-json\n"));
            // valid MonitorEvent line second
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  event: "session.ended",
                  category: "session",
                  seq: 1,
                  ts: new Date().toISOString(),
                  src: "test",
                  sessionId: "s-malform",
                })}\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      },
    });

    options.SOCKET_PATH = malformSocket;

    try {
      const stream = openEventStream();
      const events: Record<string, unknown>[] = [];

      for await (const event of stream.events) {
        const e = event as Record<string, unknown>;
        if (typeof e.event === "string") {
          events.push(e);
        }
        if (e.event === "session.ended") {
          stream.abort();
          break;
        }
      }

      // The malformed line must have been skipped; only the valid event should appear.
      expect(events.length).toBe(1);
      expect(events[0]?.event).toBe("session.ended");
      expect(events[0]?.sessionId).toBe("s-malform");
    } finally {
      malformServer.stop(true);
      try {
        unlinkSync(malformSocket);
        // dotw-ignore test-empty-catch: best-effort cleanup — file may already be gone
      } catch {
        /* already cleaned up */
      }
    }
  });
});
