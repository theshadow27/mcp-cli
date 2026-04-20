/**
 * Unified monitor event envelope.
 *
 * Every event source in the daemon maps its native events into this shape
 * before publishing to the EventBus. Consumers (SSE streams, TUI, etc.)
 * subscribe to a single typed stream instead of polling three separate silos.
 *
 * Part of #1486 (monitor epic), introduced in #1512.
 */

// ── Event categories ──

export type MonitorCategory = "session" | "work_item" | "mail";

// ── Session event names ──

export const SESSION_RESULT = "session.result" as const;
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

// ── Envelope ──

export interface MonitorEventBase {
  src: string;
  event: string;
  category: MonitorCategory;
  workItemId?: string;
  sessionId?: string;
  prNumber?: number;
  [key: string]: unknown;
}

export interface MonitorEvent extends MonitorEventBase {
  seq: number;
  ts: string;
}

export type MonitorEventInput = MonitorEventBase;
