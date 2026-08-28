/**
 * Which domain owns a poller-produced event? (#3352)
 *
 * The daemon's own pollers — work-item, CI, Copilot — emit events about work items that
 * can live in ANY domain, from a process whose cwd sits in at most one of them. They used
 * to declare `repoRoot: daemonRepoRoot` on every such event, so `EventBus.resolveDomainId`
 * partitioned the daemon's hottest table by *where the daemon was started* rather than by
 * *whose PR this is*: `mcx monitor -d X` showed another project's CI traffic and hid X's
 * own. The per-item domain was already computed and then thrown away — passed as a
 * `domain` NAME, which the bus neither reads nor preserves.
 *
 * So the answer is resolved here, once, as an **id** — the field `resolveDomainId` believes
 * outright — from the work item the event names. Every poller-facing producer routes
 * through {@link EventDomainStamper.stamp}, which is why there is one place to look when a
 * row lands in the wrong domain and one place that decides what "unknown" means.
 *
 * The daemon's own root stays as the fallback for an event that resolves to no work item
 * at all, which is the un-domained-traffic property #3040 review R3 was after — it just no
 * longer overrides a known answer.
 */

import { type MonitorEventInput, NO_DOMAIN_ID } from "@mcp-cli/core";

/**
 * The ring-0 work-item reads a domain stamp needs — cross-domain by construction (see
 * `WorkItemDb.acrossDomains`): a poller-produced event is about whatever domain the item
 * belongs to, which is exactly the domain a scoped reader could not see.
 *
 * `byPr` is single-valued: a PR number is unique per domain, so the cross-domain lookup
 * can match several rows and the caller (which owns the ambiguity warning) picks.
 */
export interface WorkItemDomainLookup {
  byId(itemId: string): { domainId: number } | null;
  byPr(prNumber: number): { domainId: number } | null;
}

export interface EventDomainStamperOptions {
  lookup: WorkItemDomainLookup;
  /**
   * Domain of last resort: the root the daemon was started in. Stamped only on an event
   * that named no identity at all — never over a work item's own domain.
   */
  daemonRepoRoot: string;
}

export interface EventDomainStamper {
  /**
   * `domain_id` of the work item this event is about, or `NO_DOMAIN_ID` when the event
   * names no item, the item is unknown, or the item is unassigned. Never a guess.
   */
  domainIdFor(input: MonitorEventInput): number;
  /**
   * Return `input` stamped with the domain of the work item it names.
   *
   * A producer that already declared an identity the bus can resolve — `domainId`,
   * `repoRoot` or `sessionId` — is left alone: this is the fallback for producers that
   * know only a work item, not a second competing derivation of a field someone else
   * already answered.
   */
  stamp(input: MonitorEventInput): MonitorEventInput;
}

export function createEventDomainStamper(opts: EventDomainStamperOptions): EventDomainStamper {
  const { lookup, daemonRepoRoot } = opts;

  const domainIdFor = (input: MonitorEventInput): number => {
    // workItemId first: it identifies exactly one row, where a PR number is unique only
    // within a domain and so can match several.
    const itemId = input.workItemId;
    if (typeof itemId === "string" && itemId !== "") return lookup.byId(itemId)?.domainId ?? NO_DOMAIN_ID;
    const prNumber = input.prNumber;
    if (typeof prNumber === "number") return lookup.byPr(prNumber)?.domainId ?? NO_DOMAIN_ID;
    return NO_DOMAIN_ID;
  };

  return {
    domainIdFor,
    stamp(input: MonitorEventInput): MonitorEventInput {
      if (input.domainId !== undefined || input.repoRoot !== undefined || input.sessionId !== undefined) return input;
      const domainId = domainIdFor(input);
      return domainId === NO_DOMAIN_ID ? { ...input, repoRoot: daemonRepoRoot } : { ...input, domainId };
    },
  };
}
