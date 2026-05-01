/**
 * Shared event-filter logic used by the IPC server's streaming endpoints.
 * Extracted from ipc-server.ts to break the event-stream ↔ ipc-server circular dependency.
 */

import { type EventFilterSpec, type MonitorEvent, createEventMatcher } from "@mcp-cli/core";

/**
 * Build a server-side predicate from GET /events query params.
 * Returns null if no filters are specified (pass-through).
 *
 * Uses createEventMatcher() from core for the shared EventFilterSpec semantics.
 * Heartbeats always pass through (server-side keepalive behaviour).
 */
export function buildEventFilter(params: URLSearchParams): ((event: Record<string, unknown>) => boolean) | null {
  const subscribeRaw = params.get("subscribe");
  const session = params.get("session");
  const prRaw = params.get("pr");
  const workItem = params.get("workItem");
  const typeRaw = params.get("type");
  const srcRaw = params.get("src");
  const phase = params.get("phase");

  if (!subscribeRaw && !session && prRaw === null && !workItem && !typeRaw && !srcRaw && !phase) {
    return null;
  }

  const prNumber = prRaw !== null ? Number(prRaw) : null;
  if (prNumber !== null && !(Number.isInteger(prNumber) && prNumber >= 1)) {
    return () => false;
  }

  const spec: EventFilterSpec = {
    ...(subscribeRaw
      ? {
          subscribe: subscribeRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as EventFilterSpec["subscribe"],
        }
      : {}),
    ...(session ? { session } : {}),
    ...(prNumber !== null ? { pr: prNumber } : {}),
    ...(workItem ? { workItem } : {}),
    ...(typeRaw
      ? {
          type: typeRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(srcRaw ? { src: srcRaw } : {}),
    ...(phase ? { phase } : {}),
  };

  const matcher = createEventMatcher(spec);

  return (event: Record<string, unknown>): boolean => {
    // Heartbeats always pass through — server-side keepalive, not a data filter concern
    if (event.category === "heartbeat" || event.event === "heartbeat") return true;
    return matcher(event as MonitorEvent);
  };
}
