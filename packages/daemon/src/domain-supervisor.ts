/**
 * One worker per registered domain, supervised by the daemon.
 *
 * The daemon owns spawning and stays up; a domain that crashes restarts one
 * domain. That is the blast-radius property epic B exists for, and the sibling
 * issue (#3045) tests it.
 *
 * **Workers are spawned lazily, on first use — not at daemon start.** Three
 * reasons, in order of weight:
 *
 * 1. A domain row is a name bound to a location and *nothing else*; it has no
 *    state column precisely because registering a domain is not a statement that
 *    anything is running (`docs/domains.md`). Spawning a worker per row at
 *    startup would give the row a de-facto state — "registered" would come to
 *    mean "running", and the doc's three command families would collapse back
 *    into one.
 * 2. Daemon startup would become O(registered domains). `mcx call` has a <50ms
 *    budget and auto-starts the daemon; a box with eight registered projects
 *    should not pay eight worker boots to run one tool.
 * 3. It is the only policy that survives the host move. For a domain with a
 *    `host`, "spawn it at daemon start" is not a thing you can do — you connect
 *    to it when you need it. Lazy is what local and remote have in common.
 *
 * The corollary is that removal cannot be lazy: nothing calls into a deleted
 * domain, so nothing would notice. {@link DomainSupervisor.sync} reaps, and the
 * daemon's existing 30s prune tick drives it.
 */

import {
  type Domain,
  type DomainSnapshot,
  type Logger,
  consoleLogger,
  domainRestartRequired,
  domainSnapshotEquals,
  isRemoteDomain,
  toDomainSnapshot,
} from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type DomainLinkFactory, createWorkerDomainLink } from "./domain-link";
import { DomainServer, type DomainServerOptions, type DomainWorkerState, RemoteDomainError } from "./domain-server";
import type { RestartPolicy } from "./restart-policy";

/** The domain rows the supervisor supervises. Narrower than `McxDb` so tests need no database. */
export interface DomainRegistry {
  getDomainById(id: number): Domain | null;
  getDomainByName(name: string): Domain | null;
  listDomains(): Domain[];
}

/**
 * What a caller learns about a domain's worker.
 *
 * The union is the point. "There is no such domain" and "the worker is coming
 * back in 500ms" are the two answers a caller must never conflate — one is a
 * permanent error, the other is a retry — and a `state` string plus a comment
 * is exactly the kind of invariant that gets rationalized past. Here they are
 * different shapes: `no-such-domain` does not even carry a domain to act on.
 */
export type DomainWorkerStatus =
  | { state: "no-such-domain"; domainId: number }
  | { state: "no-worker"; domain: DomainSnapshot }
  | { state: "starting"; domain: DomainSnapshot }
  | { state: "running"; domain: DomainSnapshot }
  | { state: "restarting"; domain: DomainSnapshot; crashes: number }
  | { state: "failed"; domain: DomainSnapshot; reason: string }
  | { state: "gone"; domain: DomainSnapshot };

/** True when the status says "try again shortly" rather than "this will not work". */
export function isTransientStatus(status: DomainWorkerStatus): boolean {
  return status.state === "starting" || status.state === "restarting" || status.state === "no-worker";
}

/**
 * Thrown when the supervisor has been stopped and cannot start anything.
 *
 * Typed rather than a bare `Error` so a caller racing daemon shutdown can
 * classify it — which is the whole distinction {@link DomainWorkerStatus} exists
 * to preserve, and it should not be lost at the one entry point.
 */
export class SupervisorStoppedError extends Error {
  readonly domainId: number;

  constructor(domainId: number) {
    super(`DomainSupervisor is stopped; not starting a worker for domain ${domainId}`);
    this.name = "SupervisorStoppedError";
    this.domainId = domainId;
  }
}

/** Thrown when a domain id or name has no row in the `domains` table. */
export class UnknownDomainError extends Error {
  readonly domain: string | number;

  constructor(domain: string | number) {
    super(
      typeof domain === "number"
        ? `No domain with id ${domain}`
        : `No domain named "${domain}" — register it with \`mcx domain add\``,
    );
    this.name = "UnknownDomainError";
    this.domain = domain;
  }
}

export interface DomainSupervisorOptions {
  registry: DomainRegistry;
  daemonId?: string | null;
  logger?: Logger;
  /** Injectable so supervision can be tested without spawning threads. */
  linkFactory?: DomainLinkFactory;
  /** Injectable MCP client, for the same reason. */
  clientFactory?: (domain: DomainSnapshot) => Client;
  restartPolicy?: RestartPolicy;
  handshakeTimeoutMs?: number;
  callTimeoutMs?: number;
  onActivity?: () => void;
}

export class DomainSupervisor {
  private readonly servers = new Map<number, DomainServer>();
  /** In-flight `ensure` calls, so two concurrent callers get one worker rather than two. */
  private readonly starting = new Map<number, Promise<DomainServer>>();
  private readonly logger: Logger;
  private stopped = false;

  constructor(private readonly opts: DomainSupervisorOptions) {
    this.logger = opts.logger ?? consoleLogger;
  }

  /** Domain ids that currently have a worker (running, starting or restarting). */
  get workerCount(): number {
    return this.servers.size;
  }

  /**
   * The worker for `domainId`, started if it is not running yet.
   *
   * Throws {@link UnknownDomainError} if the domain does not exist and
   * {@link RemoteDomainError} if it lives on another host — neither of which is
   * a condition a retry fixes, which is why they are types and not states.
   */
  async ensure(domainId: number): Promise<DomainServer> {
    if (this.stopped) throw new SupervisorStoppedError(domainId);

    // The registry is consulted FIRST, before any cached server. Returning the
    // cache first meant `ensure()` handed out a live worker bound to the old
    // path for a domain whose row had been deleted or moved — and `status()`
    // agreed it was `running` — until the 30s reconcile tick noticed. Unbounded
    // for any caller holding the returned server, which for #3044 is project
    // code executing against a deleted project's path. The read is three lines
    // and it is what makes "a removed domain loses its worker" true between
    // ticks rather than only after one.
    const row = this.opts.registry.getDomainById(domainId);
    if (!row) {
      this.reapUnserviceable(domainId, "its domain row was removed");
      throw new UnknownDomainError(domainId);
    }
    const snapshot = toDomainSnapshot(row);
    if (isRemoteDomain(snapshot)) {
      this.reapUnserviceable(domainId, `it moved to host ${snapshot.host}`);
      throw new RemoteDomainError(snapshot);
    }

    // Before the cache, so concurrent callers converge on the promise rather
    // than on a server object that has not finished starting. `startServer`
    // registers in `servers` synchronously — so that `status()` can report
    // `starting` — which meant a second caller matched the cache and was handed
    // a server whose `start()` had not resolved. That made the `starting` map
    // dead code and `ensure`'s own contract ("started if it is not running yet")
    // false.
    const inFlight = this.starting.get(domainId);
    if (inFlight) return inFlight;

    const existing = this.servers.get(domainId);
    if (existing) {
      if (domainRestartRequired(existing.domain, snapshot)) {
        this.logger.info(`[domain-supervisor] domain ${domainId} moved — replacing its worker`);
        this.drop(domainId, existing);
      } else if (existing.state === "running") {
        if (!domainSnapshotEquals(existing.domain, snapshot)) existing.adoptRename(snapshot);
        return existing;
      } else if (existing.state === "starting" || existing.state === "restarting") {
        // Transient, and therefore NOT droppable. A mid-restart worker carries
        // the crash budget that makes the backoff work, and `drop` -> `stop`
        // clears `crashTimestamps`. Discarding it here meant every crash
        // started counting from zero, `shouldRestart` never accumulated to
        // `giveUp`, and a worker that died every time restarted forever while
        // reporting healthy. The caller gets the existing server, whose
        // `call()` fails fast with `retryable: true` — the honest answer, and
        // the distinction the status union exists to carry.
        return existing;
      } else {
        // stopped / failed / gone: none of these can serve a call, and leaving
        // one in the map is how a `stopped` server got returned forever and
        // never reaped.
        this.drop(domainId, existing);
      }
    }

    const attempt = this.startServer(snapshot).finally(() => {
      this.starting.delete(domainId);
    });
    this.starting.set(domainId, attempt);
    return attempt;
  }

  /** Stop and forget a worker whose domain can no longer be served from this process. */
  private reapUnserviceable(domainId: number, why: string): void {
    const server = this.servers.get(domainId);
    if (!server) return;
    this.logger.info(`[domain-supervisor] stopping the worker for domain ${domainId} — ${why}`);
    this.drop(domainId, server);
  }

  /** As {@link ensure}, by domain name. */
  async ensureByName(name: string): Promise<DomainServer> {
    const row = this.opts.registry.getDomainByName(name);
    if (!row) throw new UnknownDomainError(name);
    return this.ensure(row.id);
  }

  /** What is happening with this domain's worker right now. */
  status(domainId: number): DomainWorkerStatus {
    const server = this.servers.get(domainId);
    if (server) return statusOf(server);
    const row = this.opts.registry.getDomainById(domainId);
    if (!row) return { state: "no-such-domain", domainId };
    return { state: "no-worker", domain: toDomainSnapshot(row) };
  }

  /** Status of every registered domain, whether or not it has a worker. */
  list(): DomainWorkerStatus[] {
    const statuses: DomainWorkerStatus[] = [];
    const seen = new Set<number>();
    for (const row of this.opts.registry.listDomains()) {
      seen.add(row.id);
      statuses.push(this.status(row.id));
    }
    // A worker whose row vanished between its start and this call still exists
    // as a process; reporting only registered rows would hide it until sync().
    for (const [id, server] of this.servers) {
      if (!seen.has(id)) statuses.push(statusOf(server));
    }
    return statuses;
  }

  /**
   * Reconcile running workers against the `domains` table.
   *
   * - A worker whose domain row is gone is stopped and dropped.
   * - A worker whose row **moved** is stopped; the next {@link ensure} starts a
   *   fresh one against the new location. Continuing to execute project code
   *   against a path the table no longer names is the worse option.
   * - A worker whose row was merely **renamed** keeps running — a rename changes
   *   the label, not the binding. See `domainRestartRequired`.
   * - A worker that gave up permanently is dropped, so the next `ensure` gets a
   *   clean attempt instead of the corpse.
   *
   * Cheap by construction: it returns immediately when nothing is running, which
   * is the normal state of a daemon whose domains are idle.
   */
  sync(): void {
    if (this.servers.size === 0 || this.stopped) return;
    for (const [id, server] of [...this.servers]) {
      const row = this.opts.registry.getDomainById(id);
      if (!row) {
        this.logger.info(`[domain-supervisor] domain ${server.domain.name} (${id}) removed — stopping its worker`);
        this.drop(id, server);
        continue;
      }
      const fresh = toDomainSnapshot(row);
      if (domainRestartRequired(server.domain, fresh)) {
        this.logger.info(
          `[domain-supervisor] domain ${id} moved (${server.domain.host ?? "local"}:${server.domain.path} → ${fresh.host ?? "local"}:${fresh.path}) — restarting its worker`,
        );
        this.drop(id, server);
        continue;
      }
      if (!domainSnapshotEquals(server.domain, fresh)) {
        // Name-only change. A rename alters the label, not the binding, so the
        // worker keeps running and only this side's view of it is updated —
        // killing a live worker over a cosmetic edit would abort a running phase
        // once #3044 lands. `adoptRename` throws if the binding moved after all.
        this.logger.info(
          `[domain-supervisor] domain ${id} renamed (${server.domain.name} → ${fresh.name}) — worker kept running`,
        );
        server.adoptRename(fresh);
      }
      if (server.state === "gone" || server.state === "failed" || server.state === "stopped") {
        // `stopped` belongs here too: `ensure` and `sync` disagreeing about it
        // meant a stopped server sat in the map, was handed back forever, and
        // was never reaped — while `retryable` said `true`, so a caller would
        // retry into a permanent dead end.
        this.logger.info(`[domain-supervisor] dropping ${server.state} worker for domain ${fresh.name} (${id})`);
        this.drop(id, server);
      }
    }
  }

  /** Stop one domain's worker, if it has one. */
  async stopDomain(domainId: number): Promise<void> {
    const server = this.servers.get(domainId);
    if (!server) return;
    this.servers.delete(domainId);
    await server.stop();
  }

  /** Stop every worker. Called on daemon shutdown; one failure never blocks the rest. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      servers.map(async (server) => {
        try {
          await server.stop();
        } catch (err) {
          this.logger.error(`[domain-supervisor] error stopping worker for ${server.domain.name}: ${err}`);
        }
      }),
    );
  }

  private async startServer(snapshot: DomainSnapshot): Promise<DomainServer> {
    const server = new DomainServer(snapshot, this.serverOptions(snapshot));
    // Registered before start so a status() during the handshake reports
    // `starting` rather than `no-worker` — the difference between "wait" and
    // "nothing is happening".
    this.servers.set(snapshot.id, server);
    try {
      await server.start();
    } catch (err) {
      this.servers.delete(snapshot.id);
      await server.stop();
      throw err;
    }
    return server;
  }

  private serverOptions(snapshot: DomainSnapshot): DomainServerOptions {
    const clientFactory = this.opts.clientFactory;
    return {
      linkFactory: this.opts.linkFactory ?? ((domain) => createWorkerDomainLink(domain)),
      ...(clientFactory ? { clientFactory: () => clientFactory(snapshot) } : {}),
      resolveDomain: (id) => {
        const row = this.opts.registry.getDomainById(id);
        return row ? toDomainSnapshot(row) : null;
      },
      daemonId: this.opts.daemonId ?? null,
      logger: this.logger,
      restartPolicy: this.opts.restartPolicy,
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      callTimeoutMs: this.opts.callTimeoutMs,
      onActivity: this.opts.onActivity,
      onGone: () => {
        // The domain was removed while its worker was restarting. Drop the
        // entry so a later re-registration under a new id starts clean.
        this.servers.delete(snapshot.id);
      },
      onPermanentlyFailed: (reason) => {
        this.logger.error(
          `[domain-supervisor] worker for domain ${snapshot.name} (${snapshot.id}) permanently failed: ${reason}`,
        );
      },
    };
  }

  private drop(domainId: number, server: DomainServer): void {
    this.servers.delete(domainId);
    void server.stop().catch((err: unknown) => {
      this.logger.error(`[domain-supervisor] error stopping worker for domain ${domainId}: ${err}`);
    });
  }
}

function statusOf(server: DomainServer): DomainWorkerStatus {
  const domain = server.domain;
  const state: DomainWorkerState = server.state;
  switch (state) {
    case "running":
      return { state: "running", domain };
    case "starting":
      return { state: "starting", domain };
    case "restarting":
      return { state: "restarting", domain, crashes: server.crashCount };
    case "failed":
      return { state: "failed", domain, reason: server.reason ?? "unknown" };
    case "gone":
      return { state: "gone", domain };
    case "stopped":
      return { state: "no-worker", domain };
    default: {
      const exhaustive: never = state;
      throw new Error(`unhandled domain worker state: ${String(exhaustive)}`);
    }
  }
}
