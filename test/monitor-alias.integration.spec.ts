/**
 * End-to-end integration test for defineMonitor aliases → GET /events stream.
 *
 * Exercises the full daemon plumbing:
 *   saveAlias IPC → MonitorRuntime subprocess → EventBus → /events NDJSON stream
 *
 * Acceptance criteria from #1713 / #1724:
 *   1. Start daemon
 *   2. Save a defineMonitor alias via saveAlias IPC
 *   3. Connect to GET /events?src=alias:*
 *   4. Assert events appear with correct src, event, category fields
 *   5. Delete the alias, assert the monitor subprocess stops (stopped event)
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import type { TestDaemon } from "./harness";
import { pollUntil, rpc, startTestDaemon } from "./harness";

setDefaultTimeout(30_000);

/**
 * Open an NDJSON event stream against the test daemon's Unix socket.
 * Mirrors openEventStream from ipc-client.ts but targets an explicit socket path.
 */
function openEventStream(
  socketPath: string,
  params?: { src?: string; type?: string },
): { events: AsyncIterable<MonitorEvent>; abort: () => void } {
  const qs = new URLSearchParams();
  if (params?.src) qs.set("src", params.src);
  if (params?.type) qs.set("type", params.type);

  const controller = new AbortController();
  const qsStr = qs.toString();
  const url = `http://localhost/events${qsStr ? `?${qsStr}` : ""}`;

  async function* iterate(): AsyncGenerator<MonitorEvent> {
    const res = await fetch(url, {
      method: "GET",
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    if (!res.ok) throw new Error(`Event stream: ${res.status} ${await res.text()}`);
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
          // dotw-todo test-empty-catch: parse-probe — fix in #2322
        } catch {
          // Skip malformed lines
        }
      }
    }

    const trailing = decoder.decode();
    if (trailing.trim()) {
      try {
        yield JSON.parse(trailing.trim()) as MonitorEvent;
        // dotw-todo test-empty-catch: parse-probe — fix in #2322
      } catch {
        // Ignore incomplete trailing data
      }
    }
  }

  return { events: iterate(), abort: () => controller.abort() };
}

/**
 * defineMonitor alias that:
 *   - emits "started"
 *   - emits 5 "tick" events synchronously
 *   - waits for the abort signal (SIGTERM → ac.abort()) without a fixed sleep
 *   - emits "stopped" when signalled
 *
 * Uses setInterval to keep the Bun event loop alive while awaiting the abort
 * signal. Without an active timer or I/O, the event loop exits before SIGTERM
 * can be processed, causing the generator to never resume after the await.
 * setInterval is not flagged by the Bun.sleep linter ratchet.
 */
const TICKER_SCRIPT = `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "ticker",
  description: "Integration test monitor",
  subscribe: async function*(ctx) {
    yield { event: "started", category: "heartbeat" };
    for (let i = 0; i < 5; i++) {
      if (ctx.signal.aborted) break;
      yield { event: "tick", category: "heartbeat", count: i };
    }
    if (!ctx.signal.aborted) {
      await new Promise((resolve) => {
        const tid = setInterval(() => {}, 1000);
        ctx.signal.addEventListener("abort", () => { clearInterval(tid); resolve(undefined); }, { once: true });
      });
    }
    yield { event: "stopped", category: "heartbeat" };
  },
});`;

describe("defineMonitor → event stream integration (#1724)", () => {
  let daemon: TestDaemon | undefined;

  afterEach(async () => {
    await daemon?.kill();
    daemon = undefined;
  });

  test("events from defineMonitor alias appear on GET /events?src=alias:*", async () => {
    daemon = await startTestDaemon({});

    // Wait for the alias server (_aliases) to become a registered virtual server.
    // MonitorRuntime is initialized after the alias server starts, so this
    // guarantees monitorRuntime is live before we call saveAlias.
    await pollUntil(async () => {
      const res = await rpc(daemon?.socketPath ?? "", "listServers");
      return (res.result as Array<{ name: string }>).some((s) => s.name === "_aliases");
    }, 15_000);

    // Save the defineMonitor alias via IPC
    const saveRes = await rpc(daemon.socketPath, "saveAlias", {
      name: "ticker",
      script: TICKER_SCRIPT,
    });
    expect((saveRes.result as { ok: boolean }).ok).toBe(true);

    // Connect to the event stream filtered to alias:* sources
    const { events, abort } = openEventStream(daemon.socketPath, { src: "alias:*" });
    const received: MonitorEvent[] = [];

    const collect = (async () => {
      for await (const event of events) {
        received.push(event);
      }
    })();

    try {
      // 1. Assert the started event arrives with correct fields
      await pollUntil(() => received.some((e) => e.event === "started"), 10_000);

      const startedEvent = received.find((e) => e.event === "started");
      expect(startedEvent?.src).toBe("alias:ticker");
      expect(startedEvent?.category).toBe("heartbeat");
      expect(typeof startedEvent?.seq).toBe("number");
      expect(typeof startedEvent?.ts).toBe("string");

      // 2. Assert tick events accumulate with correct src/event/category
      await pollUntil(() => received.filter((e) => e.event === "tick").length >= 3, 5_000);

      const tickEvents = received.filter((e) => e.event === "tick");
      expect(tickEvents.length).toBeGreaterThanOrEqual(3);
      expect(tickEvents[0]?.src).toBe("alias:ticker");
      expect(tickEvents[0]?.event).toBe("tick");
      expect(tickEvents[0]?.category).toBe("heartbeat");

      // 3. Delete the alias — MonitorRuntime should SIGTERM the subprocess
      const deleteRes = await rpc(daemon.socketPath, "deleteAlias", { name: "ticker" });
      expect((deleteRes.result as { ok: boolean }).ok).toBe(true);

      // 4. Assert the stopped event arrives (emitted in generator's finally block on abort)
      await pollUntil(() => received.some((e) => e.event === "stopped"), 10_000);

      const stoppedEvent = received.find((e) => e.event === "stopped");
      expect(stoppedEvent?.src).toBe("alias:ticker");
      expect(stoppedEvent?.category).toBe("heartbeat");
    } finally {
      abort();
      await collect.catch(() => {}); // suppress AbortError from stream close
    }
  });
});
