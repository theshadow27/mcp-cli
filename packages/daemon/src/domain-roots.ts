/**
 * Which project roots the daemon serves — read from the `domains` table, not from the
 * directory that happened to start `mcpd` (#3192).
 *
 * `mcpd` is auto-started by whichever `mcx` invocation needed it, sometimes with no cwd at
 * all (`daemon-lifecycle.ts` spawns without one). Anything derived from `process.cwd()` at
 * startup is therefore derived from process ancestry: which project's automation manifest
 * ran, and which GitHub repo the pollers queried, depended on where the first `mcx call`
 * happened to be typed. The `domains` table is the durable answer to "which projects does
 * this daemon serve", so per-project machinery is enumerated from it.
 *
 * **The fallback is the degenerate case, not the design.** A box with no registered domain
 * has nothing else to go on, and dropping the cwd entirely would silently disable automation
 * on every such box. So the cwd (or the explicit `MCP_DAEMON_REPO_ROOT` / `repo-root` config
 * override) is used *only* when the table names no local domain — never alongside one.
 */

import { type Domain, NO_DOMAIN_ID, resolveRealpath } from "@mcp-cli/core";

/** Name for the fallback root, so log lines and `mcx monitor` don't print a bare `0`. */
export const FALLBACK_ROOT_NAME = "(unregistered)";

/** One project root the daemon runs per-project machinery for. */
export interface DomainRoot {
  /** `domains.id`, or {@link NO_DOMAIN_ID} for the cwd fallback. */
  id: number;
  name: string;
  /** Absolute, realpath-resolved directory. */
  path: string;
  /** True when this root came from the daemon's cwd/override rather than the `domains` table. */
  fallback: boolean;
}

export interface DomainRootsOptions {
  /** Rows from `McxDb.listDomains()`. */
  domains: readonly Domain[];
  /**
   * Daemon cwd, or the operator's explicit override. Used **only** when `domains` names no
   * local domain. Pass null to opt out of the fallback entirely (tests, and any caller that
   * would rather do nothing than do it for the wrong project).
   */
  fallbackRoot?: string | null;
}

/**
 * The local roots to run per-project machinery for, in `domains.id` order.
 *
 * Remote domains (`host !== null`) are excluded: a repo on another host is that host's
 * daemon's job, and this process cannot read its manifest or its git remote.
 *
 * De-duplicated by resolved path. Two domain names bound to the same directory is legal —
 * the table has no unique index on `path` — but running two automation dispatchers over one
 * manifest would fire every module twice, so the lowest id wins.
 */
export function resolveDomainRoots(opts: DomainRootsOptions): DomainRoot[] {
  const roots: DomainRoot[] = [];
  const seen = new Set<string>();
  for (const domain of [...opts.domains].sort((a, b) => a.id - b.id)) {
    if (domain.host !== null) continue;
    const path = resolveRealpath(domain.path);
    if (seen.has(path)) continue;
    seen.add(path);
    roots.push({ id: domain.id, name: domain.name, path, fallback: false });
  }
  if (roots.length > 0) return roots;

  const fallback = opts.fallbackRoot;
  if (!fallback) return [];
  return [{ id: NO_DOMAIN_ID, name: FALLBACK_ROOT_NAME, path: resolveRealpath(fallback), fallback: true }];
}

/** Index {@link resolveDomainRoots} output by domain id, for `rootFor`-style lookups. */
export function domainRootIndex(roots: readonly DomainRoot[]): Map<number, DomainRoot> {
  return new Map(roots.map((root) => [root.id, root]));
}
