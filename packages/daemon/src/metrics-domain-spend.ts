/**
 * Per-domain spend rollup from `agent_sessions` (#3055, epic I / #3029).
 *
 * `agent_sessions` already carries `repo_root`, `total_cost`, `total_tokens`, and (since
 * the domain-scoped DB, #3021) `domain_id`. This module is a group-by over that table plus
 * a small resolution step from `domain_id` to the domain's name.
 *
 * **Every row and every total names its source.** Only `"daemon"` exists today — rows the
 * daemon itself spawned and tracked cost/tokens for. Transcript-scraped rows (sessions the
 * daemon did not spawn) are the sibling issue (#3056) and get a `"transcript"` source; this
 * module never mixes the two into one silently-summed total, so a later join point has to
 * label the mix rather than average over it away.
 *
 * Read-only: queries `McxDb`'s exposed raw connection (`db.database`, see db/state.ts's
 * `get database()`) plus its existing public `getDomainById` — no new tables, no writes.
 * Deliberately **not** cached — every call re-queries `agent_sessions` fresh, so a pruned
 * or re-domained session is reflected on the next read instead of lingering in a stale
 * gauge (see the accuracy requirement in #3055's acceptance criteria).
 */

import type { DomainSpendQuery, DomainSpendResult, DomainSpendSessionRow, DomainSpendTotal } from "@mcp-cli/core";
import { NO_DOMAIN_ID, SPEND_SOURCE_DAEMON, UNASSIGNED_DOMAIN } from "@mcp-cli/core";
import type { McxDb } from "./db/state";

export { SPEND_SOURCE_DAEMON, UNASSIGNED_DOMAIN };
export type { DomainSpendQuery, DomainSpendResult, DomainSpendSessionRow, DomainSpendTotal };

interface RawAgentSessionRow {
  session_id: string;
  domain_id: number;
  model: string | null;
  total_cost: number;
  total_tokens: number;
  spawned_at: string;
}

/**
 * Parse a SQLite `datetime('now')`-style string (`YYYY-MM-DD HH:MM:SS`, UTC, no zone
 * suffix — see `formatSqliteDatetime` in db/state.ts, the same convention on the write
 * side) into epoch ms. Falls back to 0 (never matches a `--since` filter) rather than
 * throwing on an unexpected format, since this only gates a `>=` comparison.
 */
function parseSqliteDatetime(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Roll up `agent_sessions` by domain. Pull-based — always re-queries the live DB, so callers
 * that need this repeatedly (the `_metrics` tool, the `mcx spend` CLI) call it fresh each
 * time rather than reading a cached/periodic snapshot.
 */
export function queryDomainSpend(db: McxDb, query: DomainSpendQuery = {}): DomainSpendResult {
  let domainIdFilter: number | null = null;
  if (query.domain !== undefined) {
    const domain = db.getDomainByName(query.domain);
    if (!domain) {
      return {
        query: { domain: query.domain, sinceMs: query.sinceMs ?? null },
        totals: [],
        sessions: [],
        unknownDomain: true,
      };
    }
    domainIdFilter = domain.id;
  }

  const raw = db.database
    .query<RawAgentSessionRow, []>(
      "SELECT session_id, domain_id, model, total_cost, total_tokens, spawned_at FROM agent_sessions ORDER BY domain_id, spawned_at",
    )
    .all();

  const nameCache = new Map<number, string>();
  const resolveDomainName = (id: number): string => {
    if (id === NO_DOMAIN_ID) return UNASSIGNED_DOMAIN;
    const cached = nameCache.get(id);
    if (cached !== undefined) return cached;
    const name = db.getDomainById(id)?.name ?? UNASSIGNED_DOMAIN;
    nameCache.set(id, name);
    return name;
  };

  const sessions: DomainSpendSessionRow[] = [];
  const totalsByDomain = new Map<string, DomainSpendTotal>();

  for (const row of raw) {
    if (domainIdFilter !== null && row.domain_id !== domainIdFilter) continue;

    const spawnedAtMs = parseSqliteDatetime(row.spawned_at);
    if (query.sinceMs !== undefined && spawnedAtMs < query.sinceMs) continue;

    const domain = resolveDomainName(row.domain_id);
    sessions.push({
      domain,
      domainId: row.domain_id,
      source: SPEND_SOURCE_DAEMON,
      sessionId: row.session_id,
      model: row.model,
      cost: row.total_cost,
      tokens: row.total_tokens,
      spawnedAtMs,
    });

    let totals = totalsByDomain.get(domain);
    if (!totals) {
      totals = { domain, source: SPEND_SOURCE_DAEMON, totalCost: 0, totalTokens: 0, sessionCount: 0 };
      totalsByDomain.set(domain, totals);
    }
    totals.totalCost += row.total_cost;
    totals.totalTokens += row.total_tokens;
    totals.sessionCount += 1;
  }

  return {
    query: { domain: query.domain ?? null, sinceMs: query.sinceMs ?? null },
    totals: [...totalsByDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
    sessions,
    unknownDomain: false,
  };
}
