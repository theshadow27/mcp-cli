/**
 * Wire types for the per-domain spend rollup exposed by the daemon's `_metrics` virtual
 * server (`get_domain_spend` tool) and consumed by `mcx spend` (#3055, epic I / #3029).
 *
 * Shared between `daemon` (produces these, rolling up `agent_sessions` by domain) and
 * `command` (consumes them for `mcx spend`) so the JSON contract has one definition
 * instead of two structurally-identical copies that could drift.
 *
 * **Every row and total names its source.** Only `"daemon"` exists today — sessions the
 * daemon itself spawned and tracked cost/tokens for. A transcript-scraped source (sessions
 * the daemon did not spawn — the sibling issue, #3056) is never silently merged into a
 * `"daemon"`-labeled total; a mixed total gets its own label rather than dropping the
 * distinction.
 */

export const SPEND_SOURCE_DAEMON = "daemon" as const;
export type SpendSource = typeof SPEND_SOURCE_DAEMON;

/** Domain label used for sessions whose `domain_id` names no registered domain (0, or a deleted one). */
export const UNASSIGNED_DOMAIN = "unassigned";

export interface DomainSpendSessionRow {
  domain: string;
  domainId: number;
  source: SpendSource;
  sessionId: string;
  model: string | null;
  cost: number;
  tokens: number;
  /** Epoch ms the session was spawned. */
  spawnedAtMs: number;
}

export interface DomainSpendTotal {
  domain: string;
  source: SpendSource;
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
}

export interface DomainSpendQuery {
  /** Restrict to one domain by name. Omitted = every domain. */
  domain?: string;
  /** Only sessions spawned at or after this epoch-ms cutoff. */
  sinceMs?: number;
}

export interface DomainSpendResult {
  query: { domain: string | null; sinceMs: number | null };
  totals: DomainSpendTotal[];
  sessions: DomainSpendSessionRow[];
  /** True when `query.domain` was given but no domain by that name is registered — totals/sessions are empty, not "all domains". */
  unknownDomain: boolean;
}
