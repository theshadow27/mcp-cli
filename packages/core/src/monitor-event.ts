/**
 * Unified monitor event envelope.
 *
 * Every event source in the daemon maps its native events into this shape
 * before publishing to the EventBus. Consumers (SSE streams, TUI, etc.)
 * subscribe to a single typed stream instead of polling three separate silos.
 *
 * Part of #1486 (monitor epic), introduced in #1512.
 * Projection layer (formatters, chunk suppression) added in #1515.
 */

// ── Event categories ──

export type MonitorCategory = "session" | "work_item" | "mail" | "heartbeat";

// ── Session event names ──

export const SESSION_RESULT = "session.result" as const;
export const SESSION_RESPONSE = "session.response" as const;
export const SESSION_PERMISSION_REQUEST = "session.permission_request" as const;
export const SESSION_ENDED = "session.ended" as const;
export const SESSION_DISCONNECTED = "session.disconnected" as const;
export const SESSION_ERROR = "session.error" as const;
export const SESSION_CLEARED = "session.cleared" as const;
export const SESSION_MODEL_CHANGED = "session.model_changed" as const;
export const SESSION_RATE_LIMITED = "session.rate_limited" as const;
export const SESSION_CONTAINMENT_WARNING = "session.containment_warning" as const;
export const SESSION_CONTAINMENT_DENIED = "session.containment_denied" as const;
export const SESSION_CONTAINMENT_ESCALATED = "session.containment_escalated" as const;
export const SESSION_CONTAINMENT_RESET = "session.containment_reset" as const;

// ── Work item event names ──

export const PR_OPENED = "pr.opened" as const;
export const PR_MERGED = "pr.merged" as const;
export const PR_CLOSED = "pr.closed" as const;
export const CHECKS_STARTED = "checks.started" as const;
export const CHECKS_PASSED = "checks.passed" as const;
export const CHECKS_FAILED = "checks.failed" as const;
export const REVIEW_APPROVED = "review.approved" as const;
export const REVIEW_CHANGES_REQUESTED = "review.changes_requested" as const;
export const PHASE_CHANGED = "phase.changed" as const;

// ── Mail event names ──

export const MAIL_RECEIVED = "mail.received" as const;

// ── Heartbeat ──

export const HEARTBEAT = "heartbeat" as const;

// ── Envelope ──

/** Common fields for all monitor events. */
export interface MonitorEventBase {
  src: string;
  event: string;
  category: MonitorCategory;
  workItemId?: string;
  sessionId?: string;
  prNumber?: number;
  /** Causal chain of seq IDs — present on events from DerivedEventPublisher (src:"daemon.derived"). Depth is capped at 4. */
  causedBy?: number[];
  [key: string]: unknown;
}

export interface MonitorEvent extends MonitorEventBase {
  seq: number;
  ts: string;
}

export type MonitorEventInput = MonitorEventBase;

// ── Projection layer (#1515) ──

const MAX_LINE = 200;

function ts(e: MonitorEvent): string {
  const d = new Date(e.ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

function wi(e: MonitorEvent): string {
  return typeof e.workItemId === "string" ? e.workItemId : "";
}

function sid(e: MonitorEvent): string {
  return typeof e.sessionId === "string" ? e.sessionId.slice(0, 8) : "";
}

function pr(e: MonitorEvent): string {
  return typeof e.prNumber === "number" ? `PR#${e.prNumber}` : "";
}

function cost(e: MonitorEvent): string {
  return typeof e.cost === "number" ? `$${e.cost.toFixed(2)}` : "";
}

function turns(e: MonitorEvent): string {
  return typeof e.numTurns === "number" ? `${e.numTurns}t` : "";
}

function cap(s: string, budget: number): string {
  return s.length > budget ? `${s.slice(0, budget - 1)}…` : s;
}

function join(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join("  ");
}

type Formatter = (e: MonitorEvent) => string;

const FORMATTERS: Partial<Record<string, Formatter>> = {
  [SESSION_RESULT]: (e) => {
    const preview = typeof e.result === "string" ? `  "${cap(e.result.replace(/\n/g, " "), 60)}"` : "";
    return join(wi(e), sid(e), cost(e), turns(e)) + preview;
  },

  [SESSION_PERMISSION_REQUEST]: (e) => {
    const tool = typeof e.toolName === "string" ? e.toolName : "";
    return join(wi(e), sid(e), tool);
  },

  [SESSION_ENDED]: (e) => join(wi(e), sid(e), cost(e), turns(e)),

  [SESSION_DISCONNECTED]: (e) => join(wi(e), sid(e)),

  [SESSION_ERROR]: (e) => {
    const msg = Array.isArray(e.errors) ? String(e.errors[0] ?? "") : "";
    return join(wi(e), sid(e), cap(msg, 80));
  },

  [SESSION_CLEARED]: (e) => join(wi(e), sid(e)),

  [SESSION_MODEL_CHANGED]: (e) => {
    const model = typeof e.model === "string" ? e.model : "";
    return join(wi(e), sid(e), model);
  },

  [SESSION_RATE_LIMITED]: (e) => {
    const retry = typeof e.retryAfterMs === "number" ? `retry in ${Math.round(e.retryAfterMs / 1000)}s` : "";
    return join(wi(e), sid(e), retry);
  },

  [SESSION_CONTAINMENT_WARNING]: (e) => {
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), sid(e), `strikes:${e.strikes ?? "?"}`, reason);
  },

  [SESSION_CONTAINMENT_DENIED]: (e) => {
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), sid(e), reason);
  },

  [SESSION_CONTAINMENT_ESCALATED]: (e) => join(wi(e), sid(e)),

  [PR_OPENED]: (e) => join(wi(e), pr(e)),

  [PR_MERGED]: (e) => join(wi(e), pr(e)),

  [PR_CLOSED]: (e) => join(wi(e), pr(e)),

  [CHECKS_STARTED]: (e) => join(wi(e), pr(e)),

  [CHECKS_PASSED]: (e) => join(wi(e), pr(e)),

  [CHECKS_FAILED]: (e) => {
    const job = typeof e.failedJob === "string" ? e.failedJob : "";
    return join(wi(e), pr(e), job);
  },

  [REVIEW_APPROVED]: (e) => {
    const reviewer = typeof e.reviewer === "string" ? e.reviewer : "";
    return join(wi(e), pr(e), reviewer);
  },

  [REVIEW_CHANGES_REQUESTED]: (e) => {
    const reviewer = typeof e.reviewer === "string" ? e.reviewer : "";
    return join(wi(e), pr(e), reviewer);
  },

  [PHASE_CHANGED]: (e) => {
    const from = typeof e.from === "string" ? e.from : "";
    const to = typeof e.to === "string" ? e.to : "";
    return join(wi(e), from && to ? `${from} → ${to}` : from || to);
  },

  [MAIL_RECEIVED]: (e) => {
    const sender = typeof e.sender === "string" ? e.sender : "";
    const recipient = typeof e.recipient === "string" ? e.recipient : "";
    return join(sender, "→", recipient);
  },

  [HEARTBEAT]: (e) => `seq:${e.seq}`,
};

/**
 * Format a MonitorEvent as a human-readable one-liner (≤200 chars).
 *
 * Format: `[HH:MM:SS] event.type  <context fields>`
 *
 * Falls back to a generic one-liner for unknown event types.
 */
export function formatMonitorEvent(e: MonitorEvent): string {
  const formatter = FORMATTERS[e.event];
  const label = e.event === HEARTBEAT ? "♥ heartbeat    " : e.event.padEnd(24);
  const detail = formatter ? formatter(e) : fallback(e);
  const line = `${ts(e)} ${label}  ${detail}`;
  return cap(line, MAX_LINE);
}

function fallback(e: MonitorEvent): string {
  const fields = Object.entries(e)
    .filter(([k]) => !["seq", "ts", "src", "event", "category"].includes(k))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${String(v).slice(0, 20)}`);
  return fields.join("  ");
}
