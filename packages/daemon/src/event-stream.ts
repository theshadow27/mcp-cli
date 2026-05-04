/**
 * HTTP streaming route handlers for the IPC server.
 *
 * Extracted from ipc-server.ts to keep the dispatcher thin.
 * Handles:
 *   GET /logs   — SSE stream for real-time log tailing
 *   GET /events — NDJSON stream for the unified monitor event bus
 */

import type { Logger } from "@mcp-cli/core";
import { getDaemonLogLines, subscribeDaemonLogs } from "./daemon-log";
import type { EventBus } from "./event-bus";
import { buildEventFilter } from "./ipc-filter";
import { metrics } from "./metrics";
import type { ServerPool } from "./server-pool";

export class EventStreamServer {
  /** Max concurrent EventBus subscribers (hard limit to avoid GC pressure). */
  static readonly MAX_EVENT_BUS_SUBSCRIBERS = 64;
  /** Heartbeat interval for the EventBus path — shorter for dead-peer detection (#1557). */
  private static readonly EVENTBUS_HEARTBEAT_MS = 15_000;
  /** Prune EventBus subscribers idle longer than this (#1557). */
  private static readonly EVENTBUS_SUB_TTL_MS = 10 * 60_000;
  /** Ring-buffer capacity for the fallback push path. */
  private static readonly EVENT_RING_CAPACITY = 256;
  /**
   * Test-mutable statics — all four are proxied via static getter/setter pairs on IpcServer
   * so that tests can patch IpcServer.X and have the change take effect without importing
   * EventStreamServer directly.  If you rename or remove any of these, update the
   * corresponding accessor on IpcServer as well.
   */
  static LIVE_BUFFER_MAX_ENTRIES = 10_000;
  static LIVE_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
  static BACKFILL_BATCH_SIZE = 1000;
  /**
   * Optional async hook called at each backfill yield point.
   * Tests inject live events here to guarantee they land in liveBuffer during the window.
   */
  static BACKFILL_YIELD_FN: (() => Promise<void>) | null = null;

  /** Ring-buffer subscriber callbacks (fallback path when no EventBus). */
  private eventSubscribers = new Set<(event: Record<string, unknown>) => void>();
  private eventSeq = 0;
  private eventBusSubId: number | null = null;
  private disposed = false;
  /** Active stream cleanup+close callbacks registered for graceful shutdown (#1962). */
  private readonly activeCleanups = new Set<() => void>();

  constructor(
    private readonly eventBus: EventBus | null,
    private readonly pool: ServerPool,
    private readonly logger: Logger,
    private readonly heartbeatIntervalMs = 30_000,
  ) {
    if (eventBus) {
      this.eventSeq = eventBus.currentSeq;
      this.eventBusSubId = eventBus.subscribe((event) => {
        this.eventSeq = event.seq;
        const envelope = event as unknown as Record<string, unknown>;
        const failed: ((e: Record<string, unknown>) => void)[] = [];
        for (const cb of this.eventSubscribers) {
          try {
            cb(envelope);
          } catch (err) {
            this.logger.warn(`[events] subscriber threw, dropping: ${err}`);
            failed.push(cb);
          }
        }
        for (const cb of failed) this.eventSubscribers.delete(cb);
      });
    }
  }

  /** Unsubscribe from EventBus and close all active streams (call from IpcServer.stop()). */
  dispose(): void {
    this.disposed = true;
    if (this.eventBusSubId !== null && this.eventBus) {
      this.eventBus.unsubscribe(this.eventBusSubId);
      this.eventBusSubId = null;
    }
    for (const fn of this.activeCleanups) {
      fn();
    }
    this.activeCleanups.clear();
  }

  /** Number of active streams tracked for graceful shutdown (for testing). */
  get activeStreamCount(): number {
    return this.activeCleanups.size;
  }

  /**
   * Push an event to all connected NDJSON event stream subscribers.
   * Only used in the ring-buffer fallback path (no EventBus).
   */
  pushEvent(event: Record<string, unknown>): void {
    const seq = ++this.eventSeq;
    const envelope = { ...event, seq };
    const failed: ((event: Record<string, unknown>) => void)[] = [];
    for (const cb of this.eventSubscribers) {
      try {
        cb(envelope);
      } catch (err) {
        this.logger.warn(`[events] subscriber threw, dropping: ${err}`);
        failed.push(cb);
      }
    }
    for (const cb of failed) this.eventSubscribers.delete(cb);
  }

  /** Current event sequence number (for testing / status). */
  get currentEventSeq(): number {
    return this.eventSeq;
  }

  /** Number of active ring-buffer subscribers (for testing). */
  get eventSubscriberCount(): number {
    return this.eventSubscribers.size;
  }

  /**
   * Handle GET /logs — Server-Sent Events stream for real-time log tailing.
   *
   * Query params:
   *   server=<name>  — stream stderr from a specific MCP server
   *   daemon=true    — stream daemon logs
   *   lines=<n>      — number of initial backfill lines (default 50)
   *   since=<ts>     — only backfill lines after this timestamp (ms)
   */
  handleLogsSSE(url: URL): Response {
    if (this.disposed) {
      return new Response("daemon shutting down", { status: 503 });
    }

    const serverName = url.searchParams.get("server");
    const isDaemon = url.searchParams.get("daemon") === "true";
    const lines = Number(url.searchParams.get("lines") ?? "50");
    const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;

    if (!serverName && !isDaemon) {
      return new Response("Missing ?server=<name> or ?daemon=true", { status: 400 });
    }

    let unsubscribe: (() => void) | undefined;
    let disposeCleanup: (() => void) | undefined;

    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();
        const send = (entry: { timestamp: number; line: string }) => {
          try {
            const data = JSON.stringify({ timestamp: entry.timestamp, line: entry.line });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {
            // Stream closed — clean up
            unsubscribe?.();
            if (disposeCleanup) this.activeCleanups.delete(disposeCleanup);
          }
        };

        disposeCleanup = () => {
          unsubscribe?.();
          unsubscribe = undefined;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        this.activeCleanups.add(disposeCleanup);

        // Backfill initial lines
        if (isDaemon) {
          let backfill = getDaemonLogLines(lines);
          if (since !== undefined) {
            backfill = backfill.filter((l) => l.timestamp > since);
          }
          for (const entry of backfill) {
            send(entry);
          }
        } else if (serverName) {
          let backfill = this.pool.getStderrLines(serverName, since === undefined ? lines : undefined);
          if (since !== undefined) {
            backfill = backfill.filter((l) => l.timestamp > since);
            if (backfill.length > lines) backfill = backfill.slice(-lines);
          }
          for (const entry of backfill) {
            send(entry);
          }
        }

        // Subscribe to new lines
        if (isDaemon) {
          unsubscribe = subscribeDaemonLogs((entry) => send(entry));
        } else if (serverName) {
          unsubscribe = this.pool.subscribeStderr((server, entry) => {
            if (server !== serverName) return;
            send(entry);
          });
        }
      },
      cancel: () => {
        unsubscribe?.();
        if (disposeCleanup) this.activeCleanups.delete(disposeCleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /**
   * Handle GET /events — NDJSON stream for real-time event delivery.
   *
   * When an EventBus is configured (unified monitor architecture, #1512):
   *   Uses EventBus subscriptions with session.response suppression and responseTail opt-in.
   *
   * Fallback (no EventBus, direct push via pushEvent()):
   *   Uses ring-buffer based delivery with connected/heartbeat envelope,
   *   plus durable log replay when since=<seq> is provided (#1513).
   *
   * Query params:
   *   subscribe=<categories>   Comma-separated category filter
   *   session=<id>             Filter to one session ID
   *   pr=<n>                   Filter to one PR number
   *   workItem=<id>            Filter to one work item ID
   *   type=<glob>              Event name glob filter (comma-separated OR)
   *   src=<pattern>            Source attribution glob filter
   *   phase=<name>             Phase filter on work item phase
   *   since=<seq>              Replay events after this cursor from the durable log (#1513)
   *   responseTail=<sessionId> Include session.response chunks for this session only
   */
  handleEventsNDJSON(url: URL): Response {
    if (this.disposed) {
      return new Response("daemon shutting down", { status: 503 });
    }

    const sinceParam = url.searchParams.get("since");
    let sinceSeq: number | null = null;
    if (sinceParam !== null) {
      const parsed = Number(sinceParam);
      if (sinceParam.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
        return new Response("since must be a non-negative integer", { status: 400 });
      }
      sinceSeq = parsed;
    }
    const eventLog = this.eventBus?.eventLog ?? null;

    const prRaw = url.searchParams.get("pr");
    if (prRaw !== null && !(Number.isInteger(Number(prRaw)) && Number(prRaw) >= 1)) {
      return new Response("pr must be a positive integer", { status: 400 });
    }

    if (sinceSeq !== null && !eventLog) {
      return new Response("since parameter requires the durable event log; replay is not available on this daemon", {
        status: 400,
      });
    }

    // ── EventBus path (unified monitor architecture, #1512/#1515) ──
    if (this.eventBus) {
      const responseTail = url.searchParams.get("responseTail");
      const eventFilter = buildEventFilter(url.searchParams);

      const shouldDeliver = (event: { event: string; sessionId?: string }) => {
        if (eventFilter !== null && !eventFilter(event as Record<string, unknown>)) return false;
        if (event.event === "session.response") {
          return responseTail !== null && event.sessionId === responseTail;
        }
        return true;
      };

      const bus = this.eventBus;

      if (bus.subscriberCount >= EventStreamServer.MAX_EVENT_BUS_SUBSCRIBERS) {
        this.logger.warn(
          `[events] subscriber limit reached (${EventStreamServer.MAX_EVENT_BUS_SUBSCRIBERS}), rejecting connection`,
        );
        return new Response("too many event stream subscribers", { status: 503 });
      }

      let subId: number | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let disposeCleanupEb: (() => void) | undefined;

      const encoder = new TextEncoder();
      const subscriberGauge = metrics.gauge("mcpd_event_bus_subscribers");

      const cleanup = () => {
        if (subId !== null) {
          bus.unsubscribe(subId);
          subId = null;
          subscriberGauge.dec();
        }
        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        if (disposeCleanupEb) {
          this.activeCleanups.delete(disposeCleanupEb);
          disposeCleanupEb = undefined;
        }
      };

      const stream = new ReadableStream(
        {
          start: async (controller) => {
            controller.enqueue(encoder.encode("\n"));

            disposeCleanupEb = () => {
              cleanup();
              try {
                controller.close();
              } catch {
                // already closed
              }
            };
            this.activeCleanups.add(disposeCleanupEb);

            let liveBuffer: Array<{ line: string; bytes: number; seq: number | undefined }> | null =
              sinceSeq !== null && eventLog ? [] : null;
            let liveBufferBytes = 0;
            let liveBufferDropped = 0;
            let liveBufferHead = 0;
            let firstDroppedSeq: number | undefined;
            let lastDroppedSeq: number | undefined;
            let highWaterMark = 0;

            const maxEntries = EventStreamServer.LIVE_BUFFER_MAX_ENTRIES;
            const maxBytes = EventStreamServer.LIVE_BUFFER_MAX_BYTES;

            subId = bus.subscribe(
              (_event, serialized) => {
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                  this.logger.warn("[events] slow consumer detected, dropping subscriber");
                  metrics.counter("mcpd_event_bus_slow_drops_total").inc();
                  cleanup();
                  try {
                    controller.error(new Error("slow consumer"));
                  } catch {
                    // already closed
                  }
                  return;
                }
                try {
                  const line = `${serialized}\n`;
                  if (liveBuffer !== null) {
                    const lineBytes = encoder.encode(line).byteLength;
                    let seq: number | undefined;
                    try {
                      const p = JSON.parse(serialized) as Record<string, unknown>;
                      seq = typeof p.seq === "number" ? p.seq : undefined;
                    } catch {
                      /* non-JSON event — skip seq tracking */
                    }
                    if (liveBufferHead >= liveBuffer.length && lineBytes > maxBytes) {
                      liveBufferDropped++;
                      if (seq !== undefined) {
                        firstDroppedSeq ??= seq;
                        lastDroppedSeq = seq;
                      }
                      return;
                    }
                    while (
                      liveBufferHead < liveBuffer.length &&
                      (liveBuffer.length - liveBufferHead >= maxEntries || liveBufferBytes + lineBytes > maxBytes)
                    ) {
                      const evicted = liveBuffer[liveBufferHead];
                      if (!evicted) break;
                      liveBufferBytes -= evicted.bytes;
                      if (evicted.seq !== undefined) {
                        firstDroppedSeq ??= evicted.seq;
                        lastDroppedSeq = evicted.seq;
                      }
                      liveBufferHead++;
                      liveBufferDropped++;
                    }
                    liveBuffer.push({ line, bytes: lineBytes, seq });
                    liveBufferBytes += lineBytes;
                  } else {
                    controller.enqueue(encoder.encode(line));
                  }
                } catch {
                  // Stream closed
                  cleanup();
                }
              },
              (event) => shouldDeliver(event),
            );
            subscriberGauge.inc();

            if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq >= 0 && eventLog) {
              let cursor = sinceSeq;
              const batchSize = EventStreamServer.BACKFILL_BATCH_SIZE;
              while (true) {
                const batch = eventLog.getSince(cursor, batchSize);
                for (const event of batch) {
                  highWaterMark = event.seq;
                  if (!shouldDeliver(event)) continue;
                  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                    this.logger.warn("[events] slow consumer during backfill, dropping subscriber");
                    metrics.counter("mcpd_event_bus_slow_drops_total").inc();
                    cleanup();
                    try {
                      controller.error(new Error("slow consumer"));
                    } catch {
                      // already closed
                    }
                    return;
                  }
                  try {
                    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                  } catch {
                    cleanup();
                    return;
                  }
                }
                if (batch.length < batchSize) break;
                cursor = batch[batch.length - 1]?.seq ?? cursor;
                await EventStreamServer.BACKFILL_YIELD_FN?.();
                await new Promise<void>((r) => setTimeout(r, 0));
              }
              const buffered = liveBuffer ?? [];
              const drainStart = liveBufferHead;
              liveBuffer = null;

              if (liveBufferDropped > 0) {
                const gap: Record<string, unknown> = { t: "gap", dropped: liveBufferDropped };
                if (firstDroppedSeq !== undefined) gap.firstDroppedSeq = firstDroppedSeq;
                if (lastDroppedSeq !== undefined) gap.lastDroppedSeq = lastDroppedSeq;
                try {
                  controller.enqueue(encoder.encode(`${JSON.stringify(gap)}\n`));
                } catch {
                  cleanup();
                  return;
                }
              }

              for (let i = drainStart; i < buffered.length; i++) {
                const entry = buffered[i];
                if (!entry) continue;
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                  this.logger.warn("[events] slow consumer during backfill drain, dropping subscriber");
                  metrics.counter("mcpd_event_bus_slow_drops_total").inc();
                  cleanup();
                  try {
                    controller.error(new Error("slow consumer"));
                  } catch {
                    // already closed
                  }
                  return;
                }
                try {
                  if (entry.seq !== undefined && entry.seq <= highWaterMark) continue;
                  controller.enqueue(encoder.encode(entry.line));
                } catch {
                  cleanup();
                  return;
                }
              }
            }

            heartbeatTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode("\n"));
              } catch {
                cleanup();
                return;
              }
              if (subId !== null) bus.touch(subId);
              bus.pruneStale(EventStreamServer.EVENTBUS_SUB_TTL_MS);
            }, EventStreamServer.EVENTBUS_HEARTBEAT_MS);
            heartbeatTimer.unref();
          },
          cancel: cleanup,
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
      );

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // ── Ring-buffer fallback path (direct pushEvent(), no EventBus) ──
    if (this.eventSubscribers.size >= EventStreamServer.MAX_EVENT_BUS_SUBSCRIBERS) {
      this.logger.warn(
        `[events] ring-buffer subscriber limit reached (${EventStreamServer.MAX_EVENT_BUS_SUBSCRIBERS}), rejecting connection`,
      );
      return new Response("too many event stream subscribers", { status: 503 });
    }

    const filter = buildEventFilter(url.searchParams);
    const fallbackResponseTail = url.searchParams.get("responseTail");
    const shouldDeliverFallback = (event: Record<string, unknown>) => {
      if (filter !== null && !filter(event)) return false;
      if (event.event === "session.response") {
        return fallbackResponseTail !== null && event.sessionId === fallbackResponseTail;
      }
      return true;
    };
    const capacity = EventStreamServer.EVENT_RING_CAPACITY;
    const ring: string[] = new Array(capacity);
    let writeIdx = 0;
    let dropped = 0;
    let pending = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lastWriteTime = Date.now();
    let disposeCleanupRb: (() => void) | undefined;

    const encoder = new TextEncoder();

    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (disposeCleanupRb) {
        this.activeCleanups.delete(disposeCleanupRb);
        disposeCleanupRb = undefined;
      }
    };

    const stream = new ReadableStream({
      start: (controller) => {
        let highWaterMark = 0;

        disposeCleanupRb = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        this.activeCleanups.add(disposeCleanupRb);

        const flush = () => {
          if (!pending) return;
          pending = false;
          const count = dropped > 0 ? capacity : writeIdx;
          const start = dropped > 0 ? dropped % capacity : 0;
          for (let i = 0; i < count; i++) {
            const line = ring[(start + i) % capacity] as string;
            try {
              controller.enqueue(encoder.encode(line));
            } catch {
              cleanup();
              return;
            }
          }
          writeIdx = 0;
          dropped = 0;
        };

        const enqueue = (line: string, seq?: number) => {
          if (seq !== undefined && seq <= highWaterMark) return;
          if (seq !== undefined) highWaterMark = seq;
          if (writeIdx < capacity) {
            ring[writeIdx++] = line;
          } else {
            ring[dropped % capacity] = line;
            dropped++;
          }
          pending = true;
          lastWriteTime = Date.now();
          queueMicrotask(flush);
        };

        controller.enqueue(encoder.encode(`${JSON.stringify({ t: "connected", seq: this.eventSeq })}\n`));
        lastWriteTime = Date.now();

        let liveBuffer: Array<{ line: string; seq: number | undefined }> | null = null;
        const subscriber = (event: Record<string, unknown>) => {
          if (!shouldDeliverFallback(event)) return;
          const line = `${JSON.stringify(event)}\n`;
          const seq = typeof event.seq === "number" ? event.seq : undefined;
          if (liveBuffer !== null) {
            liveBuffer.push({ line, seq });
          } else {
            enqueue(line, seq);
          }
        };

        this.eventSubscribers.add(subscriber);
        unsubscribe = () => {
          this.eventSubscribers.delete(subscriber);
        };

        if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq >= 0 && eventLog) {
          liveBuffer = [];
          let cursor = sinceSeq;
          while (true) {
            const batch = eventLog.getSince(cursor, 1000);
            for (const event of batch) {
              highWaterMark = event.seq;
              if (!shouldDeliverFallback(event as Record<string, unknown>)) continue;
              const line = `${JSON.stringify(event)}\n`;
              try {
                controller.enqueue(encoder.encode(line));
              } catch {
                cleanup();
                return;
              }
            }
            if (batch.length < 1000) break;
            cursor = batch[batch.length - 1]?.seq ?? cursor;
          }
          const buffered = liveBuffer;
          liveBuffer = null;
          for (const { line, seq } of buffered) {
            enqueue(line, seq);
          }
          lastWriteTime = Date.now();
        }

        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastWriteTime >= this.heartbeatIntervalMs) {
            const hb = `${JSON.stringify({ category: "heartbeat", event: "heartbeat", seq: this.eventSeq, src: "daemon", ts: new Date().toISOString() })}\n`;
            try {
              controller.enqueue(encoder.encode(hb));
              lastWriteTime = Date.now();
            } catch {
              cleanup();
            }
          }
        }, this.heartbeatIntervalMs);
        heartbeatTimer.unref();
      },
      cancel: cleanup,
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}
