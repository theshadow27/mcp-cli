/**
 * The daemon's one answer to "which domain owns this?" (#3040).
 *
 * `resolveDomainForPath` in core holds the *rule*; this holds the *lookup* — the
 * database reads, the memos, and the name↔id mapping the event filter needs. Everything
 * in the daemon that stamps a `domain_id` goes through this interface, so there is
 * exactly one place where an identity becomes a partition key and exactly one place to
 * look when a row lands in the wrong domain.
 *
 * The memos exist because the caller is `EventBus.publish`, the daemon's hottest insert.
 * The domain list is read once and memoized separately, so a `idForPath` miss costs a
 * `realpath` syscall plus an O(domains) prefix walk — not a `SELECT`. `idForSession`
 * does cost a `SELECT` on a miss, which is why it memoizes per session id.
 *
 * `invalidate()` is the release valve, and
 * `scripts/rules/domain-mutation-invalidates-resolver.rule.ts` is what stops a future
 * `mcx domain add` (#3035) from mutating the table and leaving the memos lying — because
 * "remember to call invalidate()" in a doc comment is precisely the kind of invariant
 * this epic refuses to write as prose.
 */

import { type Domain, NO_DOMAIN_ID, canonicalizeDomainPath, resolveDomainForPath } from "@mcp-cli/core";

/** The slice of `StateDb` a resolver needs. Narrow so tests need no database. */
export interface DomainSource {
  listDomains(): Domain[];
  /**
   * The repo root recorded for a session, or null/undefined when unknown.
   *
   * This is the identity join behind {@link DomainResolver.idForSession}. It reads
   * `agent_sessions.repo_root` rather than `agent_sessions.domain_id` because that
   * column has no writer yet — it is #3038's. When #3038 lands, this becomes a direct
   * column read and the path resolution here goes away.
   */
  getSessionRepoRoot?(sessionId: string): string | null | undefined;
}

export interface DomainResolver {
  /**
   * `domain_id` owning `path`, or `NO_DOMAIN_ID` when `path` is outside every domain,
   * is undefined, or is not absolute. Never guesses — there is no default domain and
   * `process.cwd()` is not one.
   */
  idForPath(path: string | undefined): number;
  /**
   * `domain_id` owning a session, resolved through the root that session recorded when
   * it was spawned, or `NO_DOMAIN_ID` when the session is unknown or rootless.
   *
   * This exists because 80% of the daemon's events carry a `sessionId` and almost none
   * carry a `repoRoot` (#3040 review R3: 98 of 25,536 rows on a real 7-day log). A
   * session's domain is a fact recorded on its own row, so this is a join on an identity
   * the event already has — not an inference from a field nobody sets.
   */
  idForSession(sessionId: string | undefined): number;
  /** `domain_id` for a registered name, or `null` when no domain has that name. */
  idForName(name: string): number | null;
  /** Name for a `domain_id`, or `null` for `NO_DOMAIN_ID` and for unregistered ids. */
  nameForId(id: number): string | null;
  /** Drop every memoized lookup. Required after any write to the `domains` table. */
  invalidate(): void;
  /** Total memoized entries across every memo. Exposed so the bound is testable (#3040 review R6). */
  memoSize(): number;
}

/**
 * A resolver for a daemon with no domain table at all: everything is `NO_DOMAIN_ID`.
 *
 * The default for `EventBus`, so the many existing tests that build a bus with no
 * database keep working — and so that "no domains configured" produces the sentinel by
 * construction rather than by an untested fallback branch.
 */
export const NULL_DOMAIN_RESOLVER: DomainResolver = {
  idForPath: () => NO_DOMAIN_ID,
  idForSession: () => NO_DOMAIN_ID,
  idForName: () => null,
  nameForId: () => null,
  invalidate: () => {},
  memoSize: () => 0,
};

/**
 * Default cap on memoized entries per memo. A daemon sees a handful of repo roots and
 * sessions; the bound exists so a pathological producer emitting per-event identities
 * cannot grow a map without limit. On overflow the memo is cleared rather than evicted
 * one-by-one: a domain lookup is cheap to redo and an LRU here would be more machinery
 * than the problem deserves.
 */
export const DEFAULT_MAX_MEMOIZED = 1024;

export interface DomainResolverOptions {
  /** Override the per-memo cap. Exists so a test can drive overflow without 1024 iterations. */
  maxMemoized?: number;
}

export function createDomainResolver(source: DomainSource, opts: DomainResolverOptions = {}): DomainResolver {
  const maxMemoized = opts.maxMemoized ?? DEFAULT_MAX_MEMOIZED;
  let domains: Domain[] | null = null;
  const byPath = new Map<string, number>();
  const bySession = new Map<string, number>();

  const all = (): Domain[] => {
    if (domains === null) domains = source.listDomains();
    return domains;
  };

  const remember = (memo: Map<string, number>, key: string, value: number): number => {
    if (memo.size >= maxMemoized) memo.clear();
    memo.set(key, value);
    return value;
  };

  const idForPath = (path: string | undefined): number => {
    if (path === undefined || path === "") return NO_DOMAIN_ID;
    const memo = byPath.get(path);
    if (memo !== undefined) return memo;

    let id = NO_DOMAIN_ID;
    try {
      // canonicalize: every `.claude/worktrees/` path is symlinked, and domains are
      // stored canonical by createDomain. Throws on a relative path — an event whose
      // repoRoot is junk gets the sentinel, not an exception on the publish path.
      id = resolveDomainForPath(canonicalizeDomainPath(path), all())?.id ?? NO_DOMAIN_ID;
    } catch {
      id = NO_DOMAIN_ID;
    }
    return remember(byPath, path, id);
  };

  return {
    idForPath,

    idForSession(sessionId: string | undefined): number {
      if (sessionId === undefined || sessionId === "") return NO_DOMAIN_ID;
      const memo = bySession.get(sessionId);
      if (memo !== undefined) return memo;
      // A source with no session lookup (every unit test that passes a bare domain list)
      // resolves to the sentinel rather than throwing.
      const root = source.getSessionRepoRoot?.(sessionId);
      const id = typeof root === "string" && root !== "" ? idForPath(root) : NO_DOMAIN_ID;
      return remember(bySession, sessionId, id);
    },

    idForName(name: string): number | null {
      return all().find((d) => d.name === name)?.id ?? null;
    },

    nameForId(id: number): string | null {
      if (id === NO_DOMAIN_ID) return null;
      return all().find((d) => d.id === id)?.name ?? null;
    },

    invalidate(): void {
      domains = null;
      byPath.clear();
      bySession.clear();
    },

    memoSize(): number {
      return byPath.size + bySession.size;
    },
  };
}
