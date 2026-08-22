/**
 * Domain scoping for agent sessions — the one place a domain is resolved.
 *
 * Sessions are partitioned by domain (`docs/domains.md`). Two facts about this
 * codebase decide where that resolution has to happen:
 *
 *   1. The **domains table lives in the daemon.** Neither `mcx` nor a session
 *      worker can open it, so neither can answer "which domain is this?".
 *   2. Every provider — claude, codex, acp, opencode, mock — reaches its worker
 *      through the same `callTool` IPC handler.
 *
 * So the daemon translates here, at that boundary: a caller supplies a domain
 * *name* (`-d phoenix`) or nothing at all, and what crosses into a worker is
 * always a resolved numeric `domainId`. Workers compare ids; they never see a
 * name, a path, or a prefix rule. That is the whole reason this replaces
 * `scopeRoot`, which asked every worker to re-implement a string-prefix match
 * and got `/foo/barbaz` inside `/foo/bar` for its trouble.
 *
 * The prefix rule now exists exactly once, in `resolveDomainForPath`, and it is
 * segment-aware. There is no second path that also resolves — and that sentence is
 * held up by `applyDomainScope` stripping every caller-supplied `domain`,
 * `domainCwd` and `domainId` before anything else happens, not by this comment.
 * An earlier version honoured a caller-supplied numeric `domainId` as "already
 * resolved", which made this paragraph false while it sat two screens above the
 * branch that contradicted it.
 */

import { isAbsolute } from "node:path";
import type { Domain } from "@mcp-cli/core";
import { NO_DOMAIN_ID, getAllProviders, toDomainFilter } from "@mcp-cli/core";

/**
 * The slice of `StateDb` this module needs. Narrow on purpose: domain scoping is
 * pure lookup, and a narrow port is what lets it be tested without a SQLite file.
 */
export interface DomainLookup {
  getDomainByName(name: string): Domain | null;
  resolveDomain(path: string): Domain | null;
}

/** Thrown when a caller names a domain that is not registered. */
export class UnknownDomainError extends Error {
  constructor(readonly domainName: string) {
    super(`unknown domain "${domainName}" — register it with \`mcx domain add ${domainName} <path>\``);
    this.name = "UnknownDomainError";
  }
}

/**
 * Tool basenames that spawn or address a session, split by how each treats a domain.
 *
 * `prompt` **records** the domain the session is born into; `session_list` and
 * `wait` **filter** by one. The other agent tools (`bye`, `interrupt`,
 * `transcript`, …) all take an explicit `sessionId`, so a domain would add
 * nothing but a way to get the answer wrong.
 */
const SPAWN_BASENAME = "prompt";
const FILTER_BASENAMES: ReadonlySet<string> = new Set(["session_list", "wait"]);

/**
 * Classify an MCP tool name as spawning a session, filtering sessions, or neither.
 *
 * Derived from the provider registry rather than a hand-written list of tool
 * names. A hand-written list is a mirror, and a mirror of the provider set is
 * exactly how `work_item_transitions.domain_id` ended up written by one caller
 * and read by four: registering a provider must be sufficient to get it scoped.
 */
export function classifyAgentTool(serverName: string, toolName: string): "spawn" | "filter" | null {
  for (const provider of getAllProviders()) {
    if (provider.serverName !== serverName) continue;
    const prefix = `${provider.toolPrefix}_`;
    if (!toolName.startsWith(prefix)) continue;
    const basename = toolName.slice(prefix.length);
    if (basename === SPAWN_BASENAME) return "spawn";
    if (FILTER_BASENAMES.has(basename)) return "filter";
    return null;
  }
  return null;
}

/**
 * Resolve a filesystem path to a domain id, or `NO_DOMAIN_ID` when it is outside
 * every registered domain.
 *
 * Non-absolute and empty paths resolve to `NO_DOMAIN_ID` rather than throwing:
 * `resolveDomain` rejects them (deliberately — see `normalizeDomainPath`), and an
 * `mcx claude ls` should not die because some caller passed a relative `cwd`.
 * "I could not tell" and "outside every domain" are the same answer here, and
 * both are the sentinel — never a guess at a domain.
 */
export function domainIdForPath(db: DomainLookup, path: string | undefined): number {
  if (!path || !isAbsolute(path)) return NO_DOMAIN_ID;
  // A LOOKUP FAILURE IS NOT AN ANSWER. This used to catch everything and return the
  // sentinel, which `toDomainFilter` turns into "no filter" — so a locked, corrupt or
  // mid-migration database degraded into showing every domain's sessions, identical in
  // output to `--all` and with nothing said. The non-absolute case above is handled
  // before we ever touch the DB, so anything thrown here is a real storage fault and
  // propagates: an error the caller sees beats a silent widening of scope.
  return db.resolveDomain(path)?.id ?? NO_DOMAIN_ID;
}

/**
 * The domain a session spawned by these args belongs to.
 *
 * Most specific location wins: the session's own `cwd`, then the repo root it
 * was cut from, then the directory `mcx` was invoked in. `cwd` before `repoRoot`
 * matters when domains nest — a domain registered on a subdirectory of a repo
 * owns sessions started there, which is `resolveDomainForPath`'s longest-prefix
 * rule showing through rather than a second rule layered on top.
 *
 * An explicit `domain` name still wins over all three, and an unregistered name
 * throws: a spawn that names a domain must land in it or fail, never fall back.
 */
export function resolveSpawnDomainId(
  db: DomainLookup,
  args: Record<string, unknown>,
  callerCwd: string | undefined,
): number {
  const named = namedDomainId(db, args);
  if (named !== null) return named;

  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
  const repoRoot = typeof args.repoRoot === "string" ? args.repoRoot : undefined;
  for (const candidate of [cwd, repoRoot, callerCwd]) {
    const id = domainIdForPath(db, candidate);
    if (id !== NO_DOMAIN_ID) return id;
  }
  return NO_DOMAIN_ID;
}

/**
 * The domain a `session_list` / `wait` call should be restricted to, or
 * `undefined` for "do not filter by domain".
 *
 * Driven entirely by arguments the caller supplied — `domain` (a name) or
 * `domainCwd` (a directory to resolve one from). It deliberately does **not**
 * fall back to whatever cwd the transport happened to carry: "no scoping
 * argument" is how `--all` has always been spelled, and a filter that switches
 * itself on would need a second flag to switch it back off.
 *
 * `undefined` also comes back when the supplied directory is outside every
 * registered domain — including the state this repo is in until domains are
 * actually registered. Filtering on the unassigned sentinel would hide every
 * session instead, so `toDomainFilter` refuses to treat it as a domain.
 */
export function resolveFilterDomainId(db: DomainLookup, args: Record<string, unknown>): number | undefined {
  const named = namedDomainId(db, args);
  if (named !== null) return toDomainFilter(named);
  const domainCwd = typeof args.domainCwd === "string" ? args.domainCwd : undefined;
  return toDomainFilter(domainIdForPath(db, domainCwd));
}

/**
 * Resolve an explicit `domain: "<name>"` argument, or `null` when none was given.
 *
 * Throws on a name that is not registered. This is the "never a guess" rule from
 * `docs/domains.md` with teeth: silently ignoring an unknown `-d` would show the
 * caller some *other* domain's sessions under the name they asked for.
 */
function namedDomainId(db: DomainLookup, args: Record<string, unknown>): number | null {
  const name = args.domain;
  if (typeof name !== "string" || name === "") return null;
  const domain = db.getDomainByName(name);
  if (!domain) throw new UnknownDomainError(name);
  return domain.id;
}

/**
 * Rewrite a `callTool` argument bag so a worker receives a resolved `domainId`
 * and never a domain name.
 *
 * **Every** caller-supplied `domain`, `domainCwd` and `domainId` is stripped
 * first, unconditionally, including on tools that are neither spawn nor filter.
 * The daemon is then the only thing that can put a `domainId` back.
 *
 * A caller-supplied `domainId` used to be honoured as "already resolved". That
 * was a second resolution path — the exact thing this module's header claims does
 * not exist — and it was reachable by anything holding the socket, including
 * every spawned agent session. It bypassed all three guards written to protect
 * the partition: `UnknownDomainError` never fired for `{domain:"nope",
 * domainId:42}`, `toDomainFilter` never got to veto `{domainId: 0}`, and a row
 * could be written against a `domains` id that has no row behind it — invisible
 * to every `-d` filter and to `countDomainDependents` forever. It had no callers:
 * nothing in the daemon passes `domainId` to `callTool`. The hole was cut for a
 * hypothetical, so it is closed rather than validated.
 */
export function applyDomainScope(
  db: DomainLookup,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  callerCwd: string | undefined,
): Record<string, unknown> {
  // Strip before classifying, so a non-scoped tool (`claude_bye`) cannot carry a
  // raw name or id through to a worker either. The old early return left `domain`
  // on those args, contradicting the promise made three paragraphs up.
  const { domain: _name, domainCwd: _cwd, domainId: _id, ...rest } = args;

  const kind = classifyAgentTool(serverName, toolName);
  if (kind === null) return rest;

  if (kind === "spawn") {
    return { ...rest, domainId: resolveSpawnDomainId(db, args, callerCwd) };
  }

  const filter = resolveFilterDomainId(db, args);
  return filter === undefined ? rest : { ...rest, domainId: filter };
}
