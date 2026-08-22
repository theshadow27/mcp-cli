/**
 * Resolving "which domain is this call in?" — once, in one function.
 *
 * Every domain-scoped surface in the daemon (the `_work_items` MCP server, the work-item
 * IPC handlers, the pollers, `ctx.domain` for phase scripts) needs the same answer from the
 * same input: a filesystem path. Answering it in each of those places is how one of them
 * ends up answering it with `process.cwd()` and a shrug — the failure `packages/core/src/
 * domain.ts` was written to prevent.
 *
 * The rule this file holds:
 *
 * - A path inside a registered domain resolves to that domain (longest prefix wins).
 * - A path outside every domain, an absent path, or an unusable one resolves to
 *   `NO_DOMAIN_ID` — the same partition every row written before domains existed lives in,
 *   so an installation that genuinely has no domains sees no behaviour change.
 *
 * **Do not read that as "no domains is the default".** `importLegacyState` runs on every
 * daemon start and registers a domain per `~/.mcp-cli/scopes/*.json` sidecar, with no user
 * action — and `mcx domain add` does not exist yet (#3035). Any box that ever used
 * `mcx scope` already has domains. Code that assumes otherwise is wrong on the boxes that
 * matter most.
 *
 * `NO_DOMAIN_ID` here is a *fallback for reads and writes of daemon-owned state*, not the
 * "never a guess" case from `docs/domains.md`. That rule governs `-d <domain>` on a command
 * the user typed, where guessing would act on the wrong project; the sentinel partition is
 * the honest home for state whose owner is genuinely unknown.
 *
 * **This resolver is for CALLER-facing surfaces only** — a request that arrives with a cwd.
 * Daemon-internal readers must NOT resolve a domain from `process.cwd()` at startup: mcpd is
 * auto-started by whichever `mcx` invocation needed it, so that binds the daemon's view to an
 * accident of process ancestry. Those readers are ring 0 — see `WorkItemDb.acrossDomains`.
 */

import { resolve } from "node:path";
import { type Domain, NO_DOMAIN_ID, WORK_ITEMS_SERVER_NAME, resolveRealpath } from "@mcp-cli/core";

/** The slice of StateDb this module needs. Narrow so tests need no database. */
export interface DomainResolver {
  /** Which domain owns `path`? `null` outside every registered domain. */
  resolveDomain(path: string): Domain | null;
}

/** A resolved domain: the id every query is partitioned by, plus its name for display. */
export interface DomainScope {
  id: number;
  /** `null` for `NO_DOMAIN_ID` — the unassigned partition has no domain row and no name. */
  name: string | null;
}

/** The unassigned partition. Shared instance: it is immutable and has no per-call state. */
export const UNSCOPED_DOMAIN: DomainScope = Object.freeze({ id: NO_DOMAIN_ID, name: null });

/**
 * Resolve `path` to the domain that owns it.
 *
 * Total: a null resolver, a missing path, a relative path, and a path outside every domain
 * all yield {@link UNSCOPED_DOMAIN}. `resolveDomain` canonicalizes, which throws on a
 * non-absolute path — a caller's cwd is not a place to raise from, so that becomes the
 * unassigned partition too.
 */
export function resolveDomainScope(resolver: DomainResolver | null, path: string | null | undefined): DomainScope {
  if (!resolver || !path) return UNSCOPED_DOMAIN;
  let domain: Domain | null;
  try {
    domain = resolver.resolveDomain(path);
  } catch {
    return UNSCOPED_DOMAIN;
  }
  if (!domain) return UNSCOPED_DOMAIN;
  return { id: domain.id, name: domain.name };
}

/**
 * The filesystem root a domain's state is keyed under.
 *
 * Phase state lives in `alias_state`, keyed by `(repo_root, namespace, key)`, and the phase
 * runner writes it under the **caller's** git root. A daemon-internal reader that substitutes
 * its own cwd therefore reads a different key and gets `{}` — no error, just an empty store,
 * the same silent-empty failure that made the startup-bound work-item readers wrong.
 *
 * `NO_DOMAIN_ID` returns `fallback` (the daemon's cwd): rows in the unassigned partition were
 * written from there, so for them, and only for them, the daemon's own directory is right.
 */
export function domainStateRoot(
  lookup: { getDomainById(id: number): Domain | null },
  domainId: number,
  fallback: string,
): string {
  if (domainId === NO_DOMAIN_ID) return fallback;
  const path = lookup.getDomainById(domainId)?.path;
  return path ? resolveRealpath(resolve(path)) : fallback;
}

/** Just the id, for callers that partition but do not display. */
export function resolveDomainId(resolver: DomainResolver | null, path: string | null | undefined): number {
  return resolveDomainScope(resolver, path).id;
}

/**
 * MCP `_meta` key carrying the caller's domain into a virtual server.
 *
 * **Why `_meta` and not a tool argument.** `_meta` is a sibling of `arguments` in the MCP
 * request, not a member of it, and the IPC `CallToolParamsSchema` is a plain zod object —
 * unknown keys in the caller's JSON are stripped, and `arguments` is the only channel a
 * session can write. So a session cannot put a domain on the wire: the daemon resolves it
 * from the caller's cwd and attaches it after the request is parsed. The scope is decided
 * before the tool ever sees the call, which is the same reflexive-containment shape epic C
 * describes — nothing to notice, nothing to reason about, nothing to talk past.
 *
 * It also keeps the domain out of every tool's `inputSchema`, so no model ever sees a
 * parameter that looks like it might widen the scope.
 */
export const DOMAIN_META_KEY = "mcx/domain";

/**
 * Virtual servers whose tools are partitioned by domain and therefore receive
 * {@link DOMAIN_META_KEY}.
 *
 * A named set rather than "every server": `_meta` reaches the server process, and mcx's
 * internal routing has no business travelling to a third-party MCP server. Epic D adds
 * `_cards` here; `_metrics` and `_spans` follow when they are scoped.
 */
export const DOMAIN_SCOPED_SERVERS: ReadonlySet<string> = new Set([WORK_ITEMS_SERVER_NAME]);

/** Read a {@link DomainScope} back out of an MCP request's `_meta`. Unusable input → unassigned. */
export function domainScopeFromMeta(meta: unknown): DomainScope {
  if (typeof meta !== "object" || meta === null) return UNSCOPED_DOMAIN;
  const raw = (meta as Record<string, unknown>)[DOMAIN_META_KEY];
  if (typeof raw !== "object" || raw === null) return UNSCOPED_DOMAIN;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || id < NO_DOMAIN_ID) return UNSCOPED_DOMAIN;
  return { id, name: typeof name === "string" ? name : null };
}
