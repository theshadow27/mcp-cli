/**
 * Shared event filter predicate for monitor events.
 *
 * `EventFilterSpec` mirrors the query-param axes from the GET /events endpoint
 * so filter semantics are identical between the server-side pushdown in
 * ipc-server.ts and the client-side `waitForEvent` helper in AliasContext.
 *
 * Part of #1584 (waitForEvent alias context helper).
 */

import { openEventStream } from "./ipc-client";
import type { MonitorCategory, MonitorEvent } from "./monitor-event";

// ── Types ──

export interface EventFilterSpec {
  subscribe?: MonitorCategory[];
  type?: string | string[];
  session?: string;
  pr?: number;
  workItem?: string;
  src?: string;
  phase?: string;
}

export class WaitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`waitForEvent timed out after ${timeoutMs}ms`);
    this.name = "WaitTimeoutError";
  }
}

// ── Helpers ──

/** Convert a glob pattern (supporting * and ?) to a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Test whether a monitor event matches an EventFilterSpec.
 *
 * Heartbeats are NOT auto-passed here — callers that need heartbeat passthrough
 * (e.g. the server-side ipc-server filter) must handle that separately.
 */
export function matchFilter(event: MonitorEvent, spec: EventFilterSpec): boolean {
  if (spec.subscribe && !spec.subscribe.includes(event.category as MonitorCategory)) return false;
  if (spec.session !== undefined && event.sessionId !== spec.session) return false;
  if (spec.pr !== undefined && event.prNumber !== spec.pr) return false;
  if (spec.workItem !== undefined && event.workItemId !== spec.workItem) return false;
  if (spec.type !== undefined) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const patterns = types.map(globToRegex);
    if (typeof event.event !== "string") return false;
    if (!patterns.some((re) => re.test(event.event))) return false;
  }
  if (spec.src !== undefined) {
    const srcPattern = globToRegex(spec.src);
    if (typeof event.src !== "string") return false;
    if (!srcPattern.test(event.src)) return false;
  }
  if (spec.phase !== undefined && event.phase !== spec.phase) return false;
  return true;
}

/** Convert an EventFilterSpec to openEventStream query params. */
export function filterSpecToStreamParams(spec: EventFilterSpec): {
  subscribe?: string;
  session?: string;
  pr?: number;
  workItem?: string;
  type?: string;
  src?: string;
  phase?: string;
} {
  return {
    subscribe: spec.subscribe?.join(","),
    session: spec.session,
    pr: spec.pr,
    workItem: spec.workItem,
    type: Array.isArray(spec.type) ? spec.type.join(",") : spec.type,
    src: spec.src,
    phase: spec.phase,
  };
}

type OpenStreamFn = typeof openEventStream;

/**
 * Create a `waitForEvent` function bound to an optional AbortSignal.
 *
 * Opens an event stream, waits for the first event matching `filter`, then
 * aborts the stream. Rejects with `WaitTimeoutError` if `timeoutMs` elapses,
 * or with the signal's abort reason if the signal fires.
 *
 * Stream is always torn down on resolve, reject, or abort — no leaked subscribers.
 *
 * `openStream` is injectable for testing (default: the real openEventStream).
 */
export function createWaitForEvent(
  signal?: AbortSignal,
  openStream: OpenStreamFn = openEventStream,
): (filter: EventFilterSpec, opts?: { timeoutMs?: number; since?: number }) => Promise<MonitorEvent> {
  return (filter, opts) => {
    return new Promise<MonitorEvent>((resolve, reject) => {
      const { events, abort: abortStream } = openStream({
        since: opts?.since,
        ...filterSpecToStreamParams(filter),
      });

      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        abortStream();
      };

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          cleanup();
          fn();
        }
      };

      if (opts?.timeoutMs !== undefined) {
        const ms = opts.timeoutMs;
        timeoutId = setTimeout(() => {
          settle(() => reject(new WaitTimeoutError(ms)));
        }, ms);
      }

      if (signal?.aborted) {
        settle(() => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")));
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          settle(() => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")));
        },
        { once: true },
      );

      (async () => {
        try {
          for await (const event of events) {
            if (settled) break;
            // Skip heartbeats — they are keepalives, not data events
            if (event.category === "heartbeat" || event.event === "heartbeat") continue;
            if (matchFilter(event, filter)) {
              settle(() => resolve(event));
              break;
            }
          }
          if (!settled) {
            settle(() => reject(new Error("Event stream ended without matching event")));
          }
        } catch (err: unknown) {
          if (settled) return;
          // AbortError from stream abort after we already settled — ignore
          if (
            err instanceof Error &&
            (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR")
          ) {
            return;
          }
          settle(() => reject(err));
        }
      })();
    });
  };
}
