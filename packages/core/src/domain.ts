/**
 * Domains — a name bound to a location, and nothing else.
 *
 * A domain row is `id`, `name`, `host`, `path`, `created_at`. There is deliberately
 * **no state column**: a domain can resolve while its machine is down, and a machine
 * can be up while its loop is off. See `docs/domains.md`.
 *
 * The resolution rule lives here as a pure function rather than as a paragraph in a
 * doc because "which domain am I in" is exactly the kind of question a tired
 * implementation answers with `process.cwd()` and a shrug. Any invariant an
 * orchestrator could rationalize past is a function, not prose.
 */

import { isAbsolute, normalize } from "node:path";
import { resolveRealpath } from "./fs";

/** A registered domain: a name bound to `[host:]path`. */
export interface Domain {
  id: number;
  name: string;
  /** NULL for a local domain. When set, the daemon routes to a domain server on that host. */
  host: string | null;
  path: string;
  createdAt: string;
}

/** The `[host:]path` half of a domain, as parsed from a CLI argument. */
export interface DomainLocation {
  host: string | null;
  path: string;
}

/**
 * Sentinel `domain_id` for rows that were written before any domain was resolved
 * (legacy imports, and every writer that has not yet been domain-scoped).
 *
 * Real domain ids come from `INTEGER PRIMARY KEY` and therefore start at 1, so 0 can
 * never collide with one. Partitioned tables declare `domain_id INTEGER NOT NULL
 * DEFAULT 0` so that a per-domain UNIQUE index keeps its teeth on unassigned rows:
 * a nullable column would make every un-domained row distinct from every other and
 * silently drop the uniqueness this schema exists to add.
 */
export const NO_DOMAIN_ID = 0;

/** True when `domainId` names an actual domain row rather than the unassigned sentinel. */
export function isDomainScoped(domainId: number): boolean {
  return domainId > NO_DOMAIN_ID;
}

/** Domain names are the mail/CLI addressing vocabulary: alphanumeric, hyphen, underscore. */
const DOMAIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** True when `name` is usable as a domain name (and therefore as a mail `user@domain` suffix). */
export function isValidDomainName(name: string): boolean {
  return DOMAIN_NAME_RE.test(name);
}

/**
 * Normalize an **absolute** path for prefix comparison: collapse `.`/`..` and
 * duplicate separators, and strip any trailing separator (except at root).
 *
 * **Throws on anything that is not absolute** — including `""` and `~/work`.
 * This used to anchor relative input at `process.cwd()`, which is precisely the
 * "answer with `process.cwd()` and a shrug" this module's header condemns: it turned
 * `~/work` into `<cwd>/~/work` and `""` into a confident answer for a missing input.
 * A constraint the caller can violate silently belongs in a throw, not in JSDoc.
 *
 * `~` is deliberately **not** expanded. A tilde means "the home directory" of whoever
 * resolves it, and for a domain bound to a host that is a different machine's home.
 * Callers that accept shell-style input expand it before they get here.
 */
export function normalizeDomainPath(path: string): string {
  if (!isAbsolute(path)) {
    const tildeHint = path.startsWith("~") ? " (expand ~ before calling — it is not expanded here)" : "";
    throw new Error(`domain path must be absolute, got ${JSON.stringify(path)}${tildeHint}`);
  }
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Normalize **and** resolve symlinks, for paths on this filesystem.
 *
 * Kept separate from {@link normalizeDomainPath} so the resolution rule stays a pure
 * function that unit-tests without a filesystem. This repo has already paid for two
 * migrations caused by storing un-canonicalized roots (#1526, #1684) — and mcx's own
 * worktrees live under `.claude/worktrees/`, which is exactly where symlinked paths
 * show up. Non-existent paths degrade to the lexical form rather than throwing.
 *
 * Only meaningful for local domains: a `host`-bound path names a directory on another
 * machine, where this process's filesystem has no say.
 */
export function canonicalizeDomainPath(path: string): string {
  return resolveRealpath(normalizeDomainPath(path));
}

/**
 * True when `child` is `parent` or lives underneath it.
 *
 * Segment-aware on purpose: `/foo/barbaz` is **not** inside `/foo/bar`, even though
 * one is a string prefix of the other.
 */
export function isPathWithin(child: string, parent: string): boolean {
  const c = normalizeDomainPath(child);
  const p = normalizeDomainPath(parent);
  if (c === p) return true;
  return c.startsWith(p === "/" ? "/" : `${p}/`);
}

/**
 * Which domain owns `path`? Walks up from `path` to the nearest registered domain.
 *
 * - **Longest matching prefix wins** when domains nest — the innermost domain owns the path.
 * - Returns `null` outside every domain. Callers turn that into an error, **never a guess**:
 *   there is no "default domain" and `process.cwd()` is not one.
 * - Only local domains (`host === null`) can own a local path; a domain that names a host
 *   describes a directory on that host, not on this filesystem.
 * - Ties (two local domains registered at the same path) resolve by name so the result is
 *   deterministic without depending on row order or on the DB's uniqueness constraint.
 *
 * `path` must be absolute — this throws otherwise rather than inventing an answer from
 * `process.cwd()`. Pure: pass an already-canonical path (see {@link canonicalizeDomainPath})
 * if the caller's input may contain symlinks.
 */
export function resolveDomainForPath(path: string, domains: Domain[]): Domain | null {
  const target = normalizeDomainPath(path);

  let best: Domain | null = null;
  let bestLength = -1;

  for (const domain of domains) {
    // A host-bound domain names a directory on another machine; a local path is never
    // inside it, and its path need not even be absolute by this filesystem's rules.
    if (domain.host !== null) continue;
    const domainPath = normalizeDomainPath(domain.path);
    if (!isPathWithin(target, domainPath)) continue;

    if (
      domainPath.length > bestLength ||
      (domainPath.length === bestLength && best !== null && domain.name < best.name)
    ) {
      best = domain;
      bestLength = domainPath.length;
    }
  }

  return best;
}

/**
 * Parse a `[host:]path` domain location.
 *
 * `~/github/phoenix` → local. `boxen0010:~/github/phoenix` → host `boxen0010`.
 * A colon that appears after a path separator is part of the path, not a host separator
 * (`/tmp/a:b` is a local path), and an empty host (`:/tmp/x`) is rejected.
 */
export function parseDomainLocation(spec: string): DomainLocation {
  const colon = spec.indexOf(":");
  if (colon <= 0) return { host: null, path: spec };

  const host = spec.slice(0, colon);
  const path = spec.slice(colon + 1);
  if (host.includes("/") || path.length === 0) return { host: null, path: spec };
  return { host, path };
}

/** Render a domain's location back to the `[host:]path` form `parseDomainLocation` accepts. */
export function formatDomainLocation(location: DomainLocation): string {
  return location.host === null ? location.path : `${location.host}:${location.path}`;
}
