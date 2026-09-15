/**
 * Guard for the StreamableHTTP standalone notification stream (#3447).
 *
 * After `notifications/initialized` is accepted, the MCP SDK unconditionally
 * opens a `GET` carrying `Accept: text/event-stream` — the standalone
 * server→client channel — and reopens it every time it ends. The reopen is
 * scheduled with a hardcoded attempt count of `0`
 * (`client/streamableHttp.js` `_scheduleReconnection(..., 0)`), so the
 * `maxRetries` cap only ever counts *consecutive failures*. A server that
 * answers `200` and then closes the stream immediately resets the counter on
 * every cycle, can never trip the cap, and never fires `onerror`. The result
 * is an unbounded ~1 req/s loop that is invisible from the client side —
 * observed in the wild at over a million requests per week against a single
 * server, all `200`, found only from the server's own telemetry.
 *
 * Two facts make this cheap to fix from our side:
 *
 *  1. mcp-cli registers no notification handlers at all. There is no
 *     `setNotificationHandler` or `fallbackNotificationHandler` anywhere in
 *     the codebase — as a *client* of remote MCP servers we discard every
 *     server-initiated message. The stream costs us requests and buys nothing.
 *  2. The SDK documents `405` on that `GET` as "the server does not offer an
 *     SSE stream at GET endpoint … an expected case that should not trigger
 *     an error": it returns without scheduling a reconnect and without
 *     calling `onerror`, leaving the POST request/response channel intact.
 *
 * So this wrapper answers the standalone `GET` with a synthetic `405` — never
 * touching the network — and the SDK quietly stops reopening it.
 *
 * Statelessness is read off the outgoing request rather than a private field.
 * The SDK records `mcp-session-id` from the initialize response and
 * `_commonHeaders()` attaches it only when a session exists, so a standalone
 * `GET` without that header means the server issued no session. A stateless
 * server has nothing to push against and no session to keep warm; suppression
 * is immediate. A stateful server may legitimately want the channel, so it is
 * allowed to reopen and only suppressed once it flaps past the window budget.
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Window over which standalone-stream reopens are counted for a stateful server. */
const REOPEN_WINDOW_MS = 60_000;

/** Reopens allowed inside the window before a stateful server's stream is suppressed. */
const REOPEN_LIMIT = 20;

/** Why the notification stream was suppressed. */
export type SuppressReason =
  /** Server issued no `mcp-session-id` — nothing to push against. */
  | "stateless"
  /** Stateful server reopened the stream faster than the window budget allows. */
  | "flapping";

export interface StreamSuppressedInfo {
  server: string;
  reason: SuppressReason;
  /** Reopens counted in the window at the moment of suppression. */
  reopens: number;
  windowMs: number;
}

export interface HttpStreamGuardOptions {
  /** Fires exactly once, when the stream is first suppressed. */
  onSuppress?: (info: StreamSuppressedInfo) => void;
  /** Underlying fetch. Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Clock. Injectable for tests. */
  now?: () => number;
  windowMs?: number;
  limit?: number;
}

/**
 * The SDK treats 405 as "this server has no GET stream" and stops reopening.
 * No body: `_startOrAuthSse` calls `response.body?.cancel()` before checking
 * the status, and a null body makes that a no-op.
 */
function suppressedResponse(): Response {
  return new Response(null, {
    status: 405,
    statusText: "Notification stream suppressed by mcp-cli",
  });
}

/** True for the standalone server→client channel: a GET that accepts SSE. */
function isNotificationStreamOpen(method: string, headers: Headers): boolean {
  if (method.toUpperCase() !== "GET") return false;
  return headers.get("accept")?.includes("text/event-stream") ?? false;
}

/**
 * Wrap `fetch` so a StreamableHTTP transport cannot sustain an unbounded,
 * silent reopen loop against the standalone notification stream.
 *
 * Every other request — the POSTs that carry real JSON-RPC traffic, and the
 * `DELETE` that ends a session — passes through untouched.
 */
export function createHttpStreamGuard(server: string, options: HttpStreamGuardOptions = {}): FetchLike {
  const { onSuppress, fetchImpl, now = Date.now, windowMs = REOPEN_WINDOW_MS, limit = REOPEN_LIMIT } = options;

  // Latched for the life of the transport. A reconnect builds a new transport
  // (and so a new guard), which is the intended way to re-arm.
  let suppressed = false;
  let reopens: number[] = [];

  const suppress = (reason: SuppressReason, count: number): Response => {
    if (!suppressed) {
      suppressed = true;
      onSuppress?.({ server, reason, reopens: count, windowMs });
    }
    return suppressedResponse();
  };

  return async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

    if (!isNotificationStreamOpen(method, headers)) {
      return await (fetchImpl ?? fetch)(url, init);
    }

    if (suppressed) return suppressedResponse();

    // No session id on the request means the initialize response carried no
    // `mcp-session-id`: the server is stateless, so the stream is pure cost.
    if (!headers.has("mcp-session-id")) {
      return suppress("stateless", 0);
    }

    const at = now();
    reopens = reopens.filter((t) => at - t < windowMs);
    reopens.push(at);

    if (reopens.length > limit) {
      return suppress("flapping", reopens.length);
    }

    return await (fetchImpl ?? fetch)(url, init);
  };
}
