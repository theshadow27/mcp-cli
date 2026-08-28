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
import type { McxDb } from "./db/state";

/**
 * The slice of `McxDb` a resolver needs. Narrow so tests need no database.
 *
 * `getSessionPath` is **required**, not optional. An optional member here is the exact
 * shape of #3040 review R1 — it would let `createDomainResolver(someMcxDb)` compile
 * against a source with no session lookup and silently yield a resolver whose session
 * path is dead, which is 80% of the daemon's traffic. A partition input a caller can
 * omit is prose; one the compiler demands is a function. Tests that genuinely do not
 * care pass `() => null` and say so.
 */
export interface DomainSource {
  listDomains(): Domain[];
  /**
   * Every filesystem path recorded for a session, best candidate first. Empty when the
   * session is unknown or recorded none.
   *
   * The identity join behind {@link DomainResolver.idForSession}. It does NOT read
   * `agent_sessions.domain_id` because that column has no writer yet — it is #3038's.
   *
   * **A list, not a single value, and the resolver short-circuits on RESOLUTION rather
   * than on PRESENCE.** That distinction is the fix for #3169 review R7. The chain was
   * `repo_root ?? worktree ?? cwd`, which short-circuits on presence — so a session with
   * a populated `worktree` handed that value over and `cwd` was never consulted. Since
   * `agent_sessions.worktree` holds a worktree *name* (`claude-mt3xvzkf`), never a path,
   * such a session resolved to the sentinel even though its `cwd` would have resolved
   * perfectly. A `??` chain cannot express "try the next one if this does not work", and
   * that is exactly what is needed here: one non-resolving candidate must not swallow the
   * rest. Returning candidates makes a future name-shaped column a no-op instead of a
   * silent regression.
   *
   * `repo_root` is NULL for the overwhelming majority of real sessions because
   * `mcx claude spawn` sets `cwd` only (#3187), so `cwd` is what actually resolves. It is
   * no weaker a signal — `resolveDomainForPath` walks up to the nearest registered
   * domain, which is precisely what `mcx domain which $PWD` is documented to do.
   */
  getSessionPaths(sessionId: string): readonly string[];
}

/**
 * The production {@link DomainSource}, over a real `McxDb`.
 *
 * Exists because this wiring was hand-copied into three places — the daemon, the IPC
 * server's fallback, and a spec — with nothing making them agree (#3169 review). That is
 * a quieter form of the same defect the R3 fix was about: change the candidate order in
 * one copy and the spec keeps asserting the old one, so the test passes while production
 * does something else. One exported factory makes the three agree by construction, which
 * is stronger than a rule that checks they still do.
 *
 * Typed structurally rather than as `McxDb` so a test can pass a stub, and imported as
 * a type only so this module keeps no runtime dependency on the database layer.
 *
 * `worktree` is deliberately NOT a candidate: `agent_sessions.worktree` holds a worktree
 * NAME, never a path (`worktree-shim.ts` writes `toolArgs.worktree = name`), so it can
 * never resolve. On a live log it contributed exactly zero — 34,917 rows resolved with
 * and without it — while its presence in a `??` chain actively suppressed `cwd`.
 */
export function createMcxDbDomainSource(db: Pick<McxDb, "listDomains" | "getSession">): DomainSource {
  return {
    listDomains: () => db.listDomains(),
    getSessionPaths: (sessionId: string) => {
      const session = db.getSession(sessionId);
      if (!session) return [];
      // repo_root first when present (most precise), cwd otherwise. Both are recorded
      // facts about the session; neither is a guess.
      return [session.repoRoot, session.cwd].filter((p): p is string => typeof p === "string" && p !== "");
    },
  };
}

export interface DomainResolver {
  /**
   * `domain_id` owning `path`, or `NO_DOMAIN_ID` when `path` is outside every domain,
   * is undefined, or is not absolute. Never guesses — there is no default domain and
   * `process.cwd()` is not one.
   */
  idForPath(path: string | undefined): number;
  /**
   * `domain_id` owning a session, resolved through a path that session recorded, or
   * `NO_DOMAIN_ID` when the session is unknown or has no recorded path.
   *
   * This exists because 80% of the daemon's events carry a `sessionId` and almost none
   * carry a `repoRoot` (#3040 review R3: 98 of 25,536 rows on a real 7-day log). A
   * session's path is a fact recorded on its own row, so this is a join on an identity
   * the event already has — not an inference from a field nobody sets.
   *
   * **Staleness:** the answer is memoized, because resolving per-event would put a
   * session lookup on the daemon's hottest write — measured at 5.3us against a 20.6us
   * event insert, so ~25% overhead. `upsertSession` can COALESCE a new root over a row
   * already memoized from `cwd`, so every agent provider calls {@link
   * DomainResolver.invalidateSession} after writing a session row
   * (`abstract-worker-server.ts`, wired in `index.ts`). This used to be documented as an
   * accepted trade with no caller, which left the same staleness class with a
   * doing-it-wrong rule on the domain-table side and prose on this one (#3169 review).
   */
  idForSession(sessionId: string | undefined): number;
  /** Forget one session's memoized domain. Call when that session's recorded path changes. */
  invalidateSession(sessionId: string): void;
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
  invalidateSession: () => {},
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
      // First candidate that RESOLVES wins — not merely the first that is present.
      let id = NO_DOMAIN_ID;
      for (const candidate of source.getSessionPaths(sessionId)) {
        if (typeof candidate !== "string" || candidate === "") continue;
        id = idForPath(candidate);
        if (id !== NO_DOMAIN_ID) break;
      }
      return remember(bySession, sessionId, id);
    },

    idForName(name: string): number | null {
      return all().find((d) => d.name === name)?.id ?? null;
    },

    nameForId(id: number): string | null {
      if (id === NO_DOMAIN_ID) return null;
      return all().find((d) => d.id === id)?.name ?? null;
    },

    invalidateSession(sessionId: string): void {
      bySession.delete(sessionId);
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
