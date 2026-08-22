/**
 * The daemon's one answer to "which domain owns this?" (#3040).
 *
 * `resolveDomainForPath` in core holds the *rule*; this holds the *lookup* — the
 * database read, the memo, and the name↔id mapping the event filter needs. Everything
 * in the daemon that stamps a `domain_id` goes through this interface, so there is
 * exactly one place where a path becomes a partition key and exactly one place to look
 * when a row lands in the wrong domain.
 *
 * The memo exists because the caller is `EventBus.publish`, the daemon's hottest insert.
 * Resolving from scratch costs a `SELECT` over `domains` plus a `realpath` syscall, per
 * event; domains change roughly never. `invalidate()` is the release valve, and
 * `scripts/rules/domain-mutation-invalidates-resolver.rule.ts` is what stops a future
 * `mcx domain add` (#3035) from mutating the table and leaving the memo lying — because
 * "remember to call invalidate()" in a doc comment is precisely the kind of invariant
 * this epic refuses to write as prose.
 */

import { type Domain, NO_DOMAIN_ID, canonicalizeDomainPath, resolveDomainForPath } from "@mcp-cli/core";

/** The slice of `StateDb` a resolver needs. Narrow so tests need no database. */
export interface DomainSource {
  listDomains(): Domain[];
}

export interface DomainResolver {
  /**
   * `domain_id` owning `path`, or `NO_DOMAIN_ID` when `path` is outside every domain,
   * is undefined, or is not absolute. Never guesses — there is no default domain and
   * `process.cwd()` is not one.
   */
  idForPath(path: string | undefined): number;
  /** `domain_id` for a registered name, or `null` when no domain has that name. */
  idForName(name: string): number | null;
  /** Name for a `domain_id`, or `null` for `NO_DOMAIN_ID` and for unregistered ids. */
  nameForId(id: number): string | null;
  /** Drop every memoized lookup. Required after any write to the `domains` table. */
  invalidate(): void;
}

/**
 * A resolver for a daemon with no domain table at all: everything is `NO_DOMAIN_ID`.
 *
 * The default for `EventBus`, so the thousands of existing tests that build a bus with
 * no database keep working — and so that "no domains configured" produces the sentinel
 * by construction rather than by an untested fallback branch.
 */
export const NULL_DOMAIN_RESOLVER: DomainResolver = {
  idForPath: () => NO_DOMAIN_ID,
  idForName: () => null,
  nameForId: () => null,
  invalidate: () => {},
};

/**
 * Cap on memoized paths. A daemon sees a handful of repo roots; the bound exists so a
 * pathological producer emitting events with per-event paths cannot grow the map without
 * limit. On overflow the memo is cleared rather than evicted one-by-one: a domain lookup
 * is cheap to redo and an LRU here would be more machinery than the problem deserves.
 */
const MAX_MEMOIZED_PATHS = 1024;

export function createDomainResolver(source: DomainSource): DomainResolver {
  let domains: Domain[] | null = null;
  const byPath = new Map<string, number>();

  const all = (): Domain[] => {
    if (domains === null) domains = source.listDomains();
    return domains;
  };

  return {
    idForPath(path: string | undefined): number {
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

      if (byPath.size >= MAX_MEMOIZED_PATHS) byPath.clear();
      byPath.set(path, id);
      return id;
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
    },
  };
}
