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
 * Create a reusable monitor event matcher from an EventFilterSpec.
 *
 * Precompiles glob-based filters so repeated event checks do not allocate or
 * recompile RegExp instances on the hot path.
 */
export function createEventMatcher(spec: EventFilterSpec): (event: MonitorEvent) => boolean {
  const subscribeSet = spec.subscribe ? new Set<MonitorCategory>(spec.subscribe) : undefined;
  const typePatterns =
    spec.type !== undefined ? (Array.isArray(spec.type) ? spec.type : [spec.type]).map(globToRegex) : undefined;
  const srcPattern = spec.src !== undefined ? globToRegex(spec.src) : undefined;

  return (event: MonitorEvent): boolean => {
    if (subscribeSet && !subscribeSet.has(event.category as MonitorCategory)) return false;
    if (spec.session !== undefined && event.sessionId !== spec.session) return false;
    if (spec.pr !== undefined && event.prNumber !== spec.pr) return false;
    if (spec.workItem !== undefined && event.workItemId !== spec.workItem) return false;
    if (typePatterns !== undefined) {
      if (typeof event.event !== "string") return false;
      if (!typePatterns.some((re) => re.test(event.event))) return false;
    }
    if (srcPattern !== undefined) {
      if (typeof event.src !== "string") return false;
      if (!srcPattern.test(event.src)) return false;
    }
    if (spec.phase !== undefined && event.phase !== spec.phase) return false;
    return true;
  };
}

/**
 * Test whether a monitor event matches an EventFilterSpec.
 *
 * Heartbeats are NOT auto-passed here — callers that need heartbeat passthrough
 * (e.g. the server-side ipc-server filter) must handle that separately.
 */
export function matchFilter(event: MonitorEvent, spec: EventFilterSpec): boolean {
  return createEventMatcher(spec)(event);
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
 * Create a `waitForEvent` function.
 *
 * `opts.signal` — when provided and fires, the in-progress wait rejects with
 * `signal.reason` (a DOMException AbortError when `abort()` is called with no
 * args). If already aborted at call time, rejection is immediate. The abort
 * listener is removed on any resolution path — no leaked listeners.
 *
 * `opts.openStream` — injectable for testing (default: the real openEventStream).
 *
 * Stream is always torn down on resolve or reject — no leaked subscribers.
 *
 * ⚠️ Race warning: if you omit `since`, events that fire between this call
 * and the stream subscription (10–100ms later) are missed. To avoid this,
 * record the latest event sequence **before** triggering the action you're
 * waiting for, then pass it as `opts.since`.
 */
export function createWaitForEvent(opts?: {
  openStream?: OpenStreamFn;
  signal?: AbortSignal;
}): (filter: EventFilterSpec, opts?: { timeoutMs?: number; since?: number }) => Promise<MonitorEvent> {
  const { openStream = openEventStream, signal } = opts ?? {};

  return (filter, opts) => {
    return new Promise<MonitorEvent>((resolve, reject) => {
      const { events, abort: abortStream } = openStream({
        since: opts?.since,
        ...filterSpecToStreamParams(filter),
      });

      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      function onAbort() {
        settle(() => reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError")));
      }

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
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

      // Register listener BEFORE checking aborted state — a signal that
      // fires between the check and registration is caught by the listener,
      // and a pre-aborted signal is caught by the post-registration check.
      signal?.addEventListener("abort", onAbort);

      if (signal?.aborted) {
        settle(() => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")));
        return;
      }

      if (opts?.timeoutMs !== undefined) {
        const ms = opts.timeoutMs;
        timeoutId = setTimeout(() => {
          settle(() => reject(new WaitTimeoutError(ms)));
        }, ms);
      }

      (async () => {
        try {
          for await (const event of events) {
            if (settled) break;
            if (
              event.category === "heartbeat" ||
              event.event === "heartbeat" ||
              (event as Record<string, unknown>).t === "heartbeat"
            )
              continue;
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
          settle(() => reject(err));
        }
      })();
    });
  };
}
