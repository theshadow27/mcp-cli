/**
 * Integration tests for createWaitForEvent against a real IPC server + EventBus.
 *
 * The unit tests in event-filter.spec.ts use fakeStream() and cannot catch
 * wiring bugs in the real call graph (openEventStream → IPC server → EventBus).
 * These tests exercise that full chain with an in-process IPC server.
 *
 * Acceptance criterion from #1584, filed as #1720.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaitTimeoutError, createWaitForEvent } from "@mcp-cli/core";
import { silentLogger } from "@mcp-cli/core";
import type { MonitorEvent } from "@mcp-cli/core";
import { EventBus } from "../packages/daemon/src/event-bus";
import { IpcServer } from "../packages/daemon/src/ipc-server";
import { pollUntil } from "./harness";

function tmpSocket(): string {
  return join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
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

/**
 * Create an openEventStream-compatible function targeting a specific Unix socket.
 *
 * Mirrors the real openEventStream (packages/core/src/ipc-client.ts) but uses the
 * provided socketPath instead of options.SOCKET_PATH — no global state mutation.
 */
function createOpenStream(socketPath: string) {
  return (params?: {
    since?: number;
    subscribe?: string;
    session?: string;
    pr?: number;
    workItem?: string;
    type?: string;
    src?: string;
    phase?: string;
    responseTail?: string;
  }): { events: AsyncIterable<MonitorEvent>; abort: () => void } => {
    const qs = new URLSearchParams();
    if (params?.since !== undefined) qs.set("since", String(params.since));
    if (params?.subscribe) qs.set("subscribe", params.subscribe);
    if (params?.session) qs.set("session", params.session);
    if (params?.pr !== undefined) qs.set("pr", String(params.pr));
    if (params?.workItem) qs.set("workItem", params.workItem);
    if (params?.type) qs.set("type", params.type);
    if (params?.src) qs.set("src", params.src);
    if (params?.phase) qs.set("phase", params.phase);
    if (params?.responseTail) qs.set("responseTail", params.responseTail);

    const controller = new AbortController();
    const qsStr = qs.toString();
    const url = `http://localhost/events${qsStr ? `?${qsStr}` : ""}`;

    async function* iterate(): AsyncGenerator<MonitorEvent> {
      const res = await fetch(url, {
        method: "GET",
        unix: socketPath,
        signal: controller.signal,
      } as RequestInit);

      if (!res.ok) {
        throw new Error(`Event stream error: ${res.status} ${await res.text()}`);
      }

      const body = res.body;
      if (!body) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      for await (const chunk of body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield JSON.parse(trimmed) as MonitorEvent;
          } catch {
            // Skip malformed lines
          }
        }
      }
      const trailing = decoder.decode();
      if (trailing.trim()) {
        try {
          yield JSON.parse(trailing.trim()) as MonitorEvent;
        } catch {
          // Ignore incomplete trailing data
        }
      }
    }

    return { events: iterate(), abort: () => controller.abort() };
  };
}

describe("waitForEvent integration (real IPC server + EventBus)", () => {
  let server: IpcServer | undefined;
  let socketPath: string;

  function startServerWithBus(): { bus: EventBus } {
    const bus = new EventBus();
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), mockDb(), null, {
      daemonId: "test-integration",
      startedAt: Date.now(),
      onActivity: () => {},
      logger: silentLogger,
      eventBus: bus,
    });
    server.start(socketPath);
    return { bus };
  }

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("resolves with matching ci.finished event from real event stream", async () => {
    const { bus } = startServerWithBus();
    const openStream = createOpenStream(socketPath);
    const waitForEvent = createWaitForEvent({ openStream });

    const baseSubscribers = bus.subscriberCount;
    const promise = waitForEvent({ type: "ci.finished" }, { timeoutMs: 5_000 });

    await pollUntil(() => bus.subscriberCount > baseSubscribers, 2_000);

    bus.publish({
      src: "test",
      event: "ci.finished",
      category: "ci",
    });

    const event = await promise;
    expect(event.event).toBe("ci.finished");
    expect(event.category).toBe("ci");
    expect(event.src).toBe("test");
    expect(typeof event.seq).toBe("number");
    expect(typeof event.ts).toBe("string");
  });

  test("skips non-matching events and resolves with correct match", async () => {
    const { bus } = startServerWithBus();
    const openStream = createOpenStream(socketPath);
    const waitForEvent = createWaitForEvent({ openStream });

    const baseSubscribers = bus.subscriberCount;
    const promise = waitForEvent({ type: "ci.finished" }, { timeoutMs: 5_000 });

    await pollUntil(() => bus.subscriberCount > baseSubscribers, 2_000);

    bus.publish({ src: "test", event: "ci.started", category: "ci" });
    bus.publish({ src: "test", event: "pr.opened", category: "work_item" });
    bus.publish({ src: "test", event: "session.result", category: "session" });
    bus.publish({ src: "test", event: "ci.finished", category: "ci" });

    const event = await promise;
    expect(event.event).toBe("ci.finished");
    expect(event.seq).toBe(4);
  });

  test("rejects with AbortError when signal fires", async () => {
    const { bus: _bus } = startServerWithBus();
    const openStream = createOpenStream(socketPath);
    const controller = new AbortController();
    const waitForEvent = createWaitForEvent({ openStream, signal: controller.signal });

    const baseSubscribers = _bus.subscriberCount;
    const promise = waitForEvent({ type: "ci.finished" }, { timeoutMs: 5_000 });

    await pollUntil(() => _bus.subscriberCount > baseSubscribers, 2_000);

    controller.abort();

    await expect(promise).rejects.toThrow("abort");
  });

  test("rejects with WaitTimeoutError when no matching event arrives", async () => {
    const { bus } = startServerWithBus();
    const openStream = createOpenStream(socketPath);
    const waitForEvent = createWaitForEvent({ openStream });

    const baseSubscribers = bus.subscriberCount;
    const promise = waitForEvent({ type: "ci.finished" }, { timeoutMs: 2_000 });

    await pollUntil(() => bus.subscriberCount > baseSubscribers, 1_000);

    bus.publish({ src: "test", event: "ci.started", category: "ci" });

    await expect(promise).rejects.toBeInstanceOf(WaitTimeoutError);
  });
});
