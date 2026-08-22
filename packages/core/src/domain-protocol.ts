/**
 * The domain-worker control protocol.
 *
 * One worker per registered domain runs that domain's project code. Today the
 * daemon reaches it with `postMessage`/`onmessage` across a Bun Worker; when a
 * domain grows a `host` it is reached over a socket to another machine instead.
 * **The protocol below is the same either way** — that is the entire reason
 * `host` is already a column on the `domains` table (`docs/domains.md`).
 *
 * Consequences that are load-bearing rather than stylistic:
 *
 * - Every message is a `type` alias constrained to {@link JsonValue}, so a field
 *   that only survives structured clone (a `Date`, a `Map`, an optional field
 *   admitting `undefined`) fails to typecheck here rather than failing in
 *   production on the day the link becomes a socket. See the `AssertJson`
 *   assertions at the bottom of this file.
 * - The worker is handed a {@link DomainSnapshot} at init instead of a database
 *   handle. A worker on another host has no access to the daemon's SQLite, so a
 *   shared handle is an in-process assumption wearing a convenience costume.
 * - The snapshot is not authoritative state, it is a copy. The `domains` table
 *   is the source of truth, and a worker restart re-reads it — which is also the
 *   answer to "what state survives a restart": nothing in the worker's memory.
 * - `ready` carries `domain_id` so the supervisor can verify the far side bound
 *   the domain it was asked to bind. In-process that is nearly tautological;
 *   over a socket to a host serving several domains it is the check that catches
 *   a mis-routed link.
 */

import { AGENT_PROTOCOL_VERSION } from "./agent-protocol";
import type { Domain } from "./domain";
import type { JsonValue } from "./wire";

/**
 * A wire-safe copy of the `domains` row a worker is bound to: a name bound to a
 * location, and nothing else. No state column — see `docs/domains.md`.
 */
export type DomainSnapshot = {
  id: number;
  name: string;
  /** `null` for a local domain; a hostname or ssh alias when the domain lives elsewhere. */
  host: string | null;
  path: string;
  createdAt: string;
};

/** Copy the fields of a domain row that cross the wire. */
export function toDomainSnapshot(domain: Domain): DomainSnapshot {
  return { id: domain.id, name: domain.name, host: domain.host, path: domain.path, createdAt: domain.createdAt };
}

/**
 * True when two snapshots address the same location under the same name.
 *
 * A worker is bound to a location at init, so a change here means the running
 * worker is executing against a path or a name that no longer exists. `createdAt`
 * is excluded deliberately: it cannot change for a given `id`, and a domain
 * deleted and re-added is a different `id` (`domains.id` is AUTOINCREMENT
 * precisely so an id is never re-handed).
 */
export function domainSnapshotEquals(a: DomainSnapshot, b: DomainSnapshot): boolean {
  return a.id === b.id && a.name === b.name && a.host === b.host && a.path === b.path;
}

/** True when the domain lives on another host and cannot be served by a local worker. */
export function isRemoteDomain(domain: DomainSnapshot): boolean {
  return domain.host !== null;
}

// ── Daemon → worker ──

/** Bind a freshly spawned worker to one domain. The first message on every link. */
export type DomainInitMessage = {
  type: "init";
  protocol_version: number;
  /** `null` when the daemon has no identity to advertise (tests, one-shot runs). */
  daemonId: string | null;
  domain: DomainSnapshot;
};

export type DomainControlMessage = DomainInitMessage;

/** Build the init message for `domain`. */
export function domainInitMessage(domain: DomainSnapshot, daemonId: string | null): DomainInitMessage {
  return { type: "init", protocol_version: AGENT_PROTOCOL_VERSION, daemonId, domain };
}

// ── Worker → daemon ──

/** The worker bound its domain and its MCP server is accepting requests. */
export type DomainReadyMessage = {
  type: "ready";
  supported_protocol_version: number;
  /** The domain this worker actually bound — verified against what was asked for. */
  domain_id: number;
};

/** The worker failed to start. Terminal for that worker; the supervisor decides about restarting. */
export type DomainErrorMessage = {
  type: "error";
  message: string;
};

export type DomainWorkerMessage = DomainReadyMessage | DomainErrorMessage;

export const DOMAIN_WORKER_MESSAGE_TYPES: ReadonlySet<string> = new Set<DomainWorkerMessage["type"]>([
  "ready",
  "error",
]);

/** True when `data` is a control message from the worker (as opposed to JSON-RPC traffic). */
export function isDomainWorkerMessage(data: unknown): data is DomainWorkerMessage {
  if (typeof data !== "object" || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && DOMAIN_WORKER_MESSAGE_TYPES.has(type);
}

/** True when `data` is a JSON-RPC message (MCP traffic) rather than a control message. */
export function isJsonRpcMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

/** Thrown when a worker reports itself bound to a domain other than the one it was asked to serve. */
export class DomainIdentityMismatchError extends Error {
  readonly requested: number;
  readonly reported: number;

  constructor(requested: number, reported: number) {
    super(`Domain worker identity mismatch: asked for domain ${requested}, worker reported domain ${reported}`);
    this.name = "DomainIdentityMismatchError";
    this.requested = requested;
    this.reported = reported;
  }
}

/**
 * Verify a `ready` message came from the worker we asked for. Over a socket this
 * is the difference between "my domain's worker" and "some domain's worker".
 */
export function assertDomainIdentity(requested: number, ready: DomainReadyMessage): void {
  if (ready.domain_id !== requested) throw new DomainIdentityMismatchError(requested, ready.domain_id);
}

// ── Compile-time wire-safety assertions ──
// A field that structured clone survives but JSON does not (Date, Map, an
// optional property admitting `undefined`) fails to satisfy JsonValue and breaks
// the build here, at the declaration, rather than on the day the link becomes a
// socket. Deleting these lines is the only way past them, which is the point.

type AssertJson<T extends JsonValue> = T;

/** Every message on the domain link, restated under the {@link JsonValue} constraint. */
export type WireSafeDomainMessages = {
  snapshot: AssertJson<DomainSnapshot>;
  init: AssertJson<DomainInitMessage>;
  ready: AssertJson<DomainReadyMessage>;
  error: AssertJson<DomainErrorMessage>;
};
