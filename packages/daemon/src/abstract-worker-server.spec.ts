import { afterEach, describe, expect, mock, test } from "bun:test";
import { silentLogger } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { testOptions } from "../../../test/test-options";
import {
  AbstractWorkerServer,
  BASE_WORKER_EVENT_TYPES,
  type DbUpsertSession,
  type WorkerServerDescriptor,
} from "./abstract-worker-server";
import { StateDb } from "./db/state";
import type { MetricsCollector } from "./metrics";
import type { WorkerClientTransport } from "./worker-transport";

// ── Minimal concrete subclass ──

class StubWorkerServer extends AbstractWorkerServer {
  get descriptor(): WorkerServerDescriptor {
    return {
      providerName: "stub",
      displayName: "Stub",
      serverName: "_stub",
      workerScript: "stub-worker",
      metrics: {
        crashLoopStopped: "stub_crash_loop_stopped",
        crashesTotal: "stub_crashes_total",
        activeSessions: "stub_active_sessions",
        sessionsTotal: "stub_sessions_total",
      },
    };
  }
}

// Subclass that records hook call order
class SpyWorkerServer extends StubWorkerServer {
  readonly callLog: string[] = [];
  // undefined = delegate to super(); null = return null (skip cleanup); Set = return that Set
  captureOrphanReturn: Set<string> | null | undefined = undefined;

  protected override onCrashDetected(): void {
    this.callLog.push("onCrashDetected");
  }
  protected override captureOrphanedSessions(): Set<string> | null {
    this.callLog.push("captureOrphanedSessions");
    return this.captureOrphanReturn !== undefined ? this.captureOrphanReturn : super.captureOrphanedSessions();
  }
  protected override preCrashClearState(): void {
    this.callLog.push("preCrashClearState");
  }
  protected override teardownWorkerExtra(): void {
    this.callLog.push("teardownWorkerExtra");
  }
  protected override onPostStart(): void {
    this.callLog.push("onPostStart");
  }
  protected override onOrphanSessionEnd(sessionId: string): void {
    this.callLog.push(`onOrphanSessionEnd:${sessionId}`);
  }
}

// ── Mock helpers ──

function mockWorkerFactory() {
  return (_scriptPath: string) => {
    const w = {
      postMessage: mock((_msg: unknown) => {
        queueMicrotask(() => {
          w.onmessage?.({ data: { type: "ready" } } as MessageEvent);
        });
      }),
      terminate: mock(() => {}),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent | Event) => void) | null,
    };
    return w as unknown as Worker;
  };
}

const instantClient = () =>
  ({
    connect: async () => {},
    close: async () => {},
  }) as unknown as Client;

function makeServer<T extends StubWorkerServer>(
  Cls: new (
    db: StateDb,
    daemonId?: string,
    clientFactory?: () => Client,
    logger?: typeof silentLogger,
    handshakeTimeoutMs?: number,
    metrics?: MetricsCollector,
    workerFactory?: (path: string) => Worker,
  ) => T,
  db: StateDb,
  extraOpts?: { clientFactory?: () => Client; workerFactory?: (path: string) => Worker },
): T {
  return new Cls(
    db,
    undefined,
    extraOpts?.clientFactory ?? instantClient,
    silentLogger,
    undefined,
    undefined,
    extraOpts?.workerFactory ?? mockWorkerFactory(),
  );
}

type Internals = {
  handleWorkerCrash: (reason: string) => Promise<void>;
  handleWorkerEvent: (event: unknown) => void;
  worker: Worker | null;
  transport: WorkerClientTransport | null;
  client: Client | null;
};

function internals(server: AbstractWorkerServer): Internals {
  return server as unknown as Internals;
}

// ── Tests ──

describe("AbstractWorkerServer", () => {
  let server: StubWorkerServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  // ── Crash-restart hook call order ──

  describe("crash-restart cycle hook order", () => {
    test("fires hooks in order: onCrashDetected → captureOrphanedSessions → preCrashClearState → teardownWorkerExtra → onPostStart → onOrphanSessionEnd", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const spy = makeServer(SpyWorkerServer, db);
      server = spy;

      await server.start();

      // Add a session so we can observe onOrphanSessionEnd
      internals(server).handleWorkerEvent({
        type: "db:upsert",
        session: { sessionId: "hook-order-1", state: "active" },
      });

      await internals(server).handleWorkerCrash("test crash");

      const log = spy.callLog;
      const crashDetectedIdx = log.indexOf("onCrashDetected");
      const captureOrphansIdx = log.indexOf("captureOrphanedSessions");
      const preCrashIdx = log.indexOf("preCrashClearState");
      const teardownIdx = log.indexOf("teardownWorkerExtra");
      const postStartIdx = log.lastIndexOf("onPostStart"); // restart fires a second onPostStart
      const orphanEndIdx = log.findIndex((e) => e.startsWith("onOrphanSessionEnd:"));

      expect(crashDetectedIdx).toBeGreaterThanOrEqual(0);
      expect(captureOrphansIdx).toBeGreaterThan(crashDetectedIdx);
      expect(preCrashIdx).toBeGreaterThan(captureOrphansIdx);
      expect(teardownIdx).toBeGreaterThan(preCrashIdx);
      expect(postStartIdx).toBeGreaterThan(teardownIdx);
      expect(orphanEndIdx).toBeGreaterThan(postStartIdx);
    });
  });

  // ── onPostStart throw safety ──

  describe("onPostStart() throw safety", () => {
    test("cleans up worker/client/transport and rethrows when onPostStart throws", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);

      class ThrowingPostStartServer extends StubWorkerServer {
        protected override onPostStart(): void {
          throw new Error("onPostStart failed");
        }
      }

      server = makeServer(ThrowingPostStartServer, db);

      await expect(server.start()).rejects.toThrow("onPostStart failed");

      const i = internals(server);
      expect(i.worker).toBeNull();
      expect(i.transport).toBeNull();
      expect(i.client).toBeNull();
    });

    test("subsequent start() succeeds after onPostStart throw is fixed", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);

      let shouldThrow = true;

      class ConditionalPostStartServer extends StubWorkerServer {
        protected override onPostStart(): void {
          if (shouldThrow) throw new Error("onPostStart failed");
        }
      }

      server = makeServer(ConditionalPostStartServer, db, { workerFactory: mockWorkerFactory() });

      await expect(server.start()).rejects.toThrow("onPostStart failed");

      shouldThrow = false;
      // Must succeed — worker/client/transport were nulled out after the first failure
      const { client } = await server.start();
      expect(client).not.toBeNull();
    });
  });

  // ── processSessionUpsert throw safety ──

  describe("processSessionUpsert throw safety", () => {
    test("does not add ghost entry to activeSessions when processSessionUpsert throws", () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);

      class ThrowingUpsertServer extends StubWorkerServer {
        protected override processSessionUpsert(_session: DbUpsertSession): DbUpsertSession {
          throw new Error("upsert hook failed");
        }
      }

      server = makeServer(ThrowingUpsertServer, db);

      const s = server;
      expect(() => {
        internals(s).handleWorkerEvent({
          type: "db:upsert",
          session: { sessionId: "ghost-1", state: "active" },
        });
      }).toThrow("upsert hook failed");

      // Session must NOT appear in activeSessions — no ghost entry
      expect(server.hasActiveSessions()).toBe(false);
    });

    test("successfully adds session when processSessionUpsert returns normally", () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = makeServer(StubWorkerServer, db);

      internals(server).handleWorkerEvent({
        type: "db:upsert",
        session: { sessionId: "good-1", state: "active" },
      });

      expect(server.hasActiveSessions()).toBe(true);
    });
  });

  // ── captureOrphanedSessions null semantics ──

  describe("captureOrphanedSessions() null vs empty Set semantics", () => {
    test("returning null skips orphan cleanup — sessions are NOT ended by the orphan handler", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const spy = makeServer(SpyWorkerServer, db);
      server = spy;
      // Override to return null
      spy.captureOrphanReturn = null;

      await server.start();

      internals(server).handleWorkerEvent({
        type: "db:upsert",
        session: { sessionId: "orphan-null-1", state: "active" },
      });
      db.upsertSession({ sessionId: "orphan-null-1", state: "active" });

      await internals(server).handleWorkerCrash("test crash");

      // onOrphanSessionEnd must NOT have been called
      expect(spy.callLog.some((e) => e.startsWith("onOrphanSessionEnd:"))).toBe(false);

      // Session stays in its pre-restart state (disconnected, not ended)
      const row = db.getSession("orphan-null-1");
      expect(row?.state).not.toBe("ended");
    });

    test("returning empty Set skips orphan cleanup — no sessions to iterate", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);

      class EmptySetServer extends SpyWorkerServer {
        protected override captureOrphanedSessions(): Set<string> {
          this.callLog.push("captureOrphanedSessions");
          return new Set(); // empty set — no orphans
        }
      }

      server = makeServer(EmptySetServer, db);
      await server.start();

      internals(server).handleWorkerEvent({
        type: "db:upsert",
        session: { sessionId: "orphan-empty-1", state: "active" },
      });
      db.upsertSession({ sessionId: "orphan-empty-1", state: "active" });

      await internals(server).handleWorkerCrash("test crash");

      expect((server as SpyWorkerServer).callLog.some((e) => e.startsWith("onOrphanSessionEnd:"))).toBe(false);
    });

    test("returning Set with sessionIds ends those sessions after restart", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const spy = makeServer(SpyWorkerServer, db);
      server = spy;
      // Default captureOrphanedSessions returns a copy of activeSessions
      // (leave captureOrphanReturn as null so super() is called)

      await server.start();

      internals(server).handleWorkerEvent({
        type: "db:upsert",
        session: { sessionId: "orphan-set-1", state: "active" },
      });
      db.upsertSession({ sessionId: "orphan-set-1", state: "active" });

      await internals(server).handleWorkerCrash("test crash");

      expect(spy.callLog).toContain("onOrphanSessionEnd:orphan-set-1");
      const row = db.getSession("orphan-set-1");
      expect(row?.state).toBe("ended");
    });
  });

  // ── handleWorkerEvent exhaustiveness guard ──

  describe("handleWorkerEvent exhaustiveness", () => {
    test("BASE_WORKER_EVENT_TYPES covers all BaseWorkerEvent type literals", () => {
      const expected = [
        "ready",
        "db:upsert",
        "db:state",
        "db:cost",
        "db:disconnected",
        "db:end",
        "metrics:inc",
        "metrics:observe",
      ];
      expect(BASE_WORKER_EVENT_TYPES.size).toBe(expected.length);
      for (const t of expected) {
        expect(BASE_WORKER_EVENT_TYPES.has(t)).toBe(true);
      }
    });

    test("default branch in handleWorkerEvent does not throw for unrecognised types", () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = makeServer(StubWorkerServer, db);

      // Cast to bypass isBaseWorkerEvent routing — call the private method directly
      // with a type value that is not in the union (simulates a new unhandled type)
      const s = server;
      expect(() => {
        internals(s).handleWorkerEvent({ type: "unknown:future:type" } as never);
      }).not.toThrow();
    });
  });
});
