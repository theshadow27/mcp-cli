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
  domainSnapshotEquals,
  isRemoteDomain,
  toDomainSnapshot,
} from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type DomainLinkFactory, createWorkerDomainLink } from "./domain-link";
import { DomainServer, type DomainServerOptions, type DomainWorkerState, RemoteDomainError } from "./domain-server";
import type { RestartPolicy } from "./restart-policy";

/** The domain rows the supervisor supervises. Narrower than `StateDb` so tests need no database. */
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
    if (this.stopped) throw new Error("DomainSupervisor is stopped");
    const existing = this.servers.get(domainId);
    if (existing && existing.state !== "gone" && existing.state !== "failed") return existing;

    const inFlight = this.starting.get(domainId);
    if (inFlight) return inFlight;

    const row = this.opts.registry.getDomainById(domainId);
    if (!row) throw new UnknownDomainError(domainId);
    const snapshot = toDomainSnapshot(row);
    if (isRemoteDomain(snapshot)) throw new RemoteDomainError(snapshot);

    const attempt = this.startServer(snapshot).finally(() => {
      this.starting.delete(domainId);
    });
    this.starting.set(domainId, attempt);
    return attempt;
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
   * - A worker whose row moved or was renamed is stopped; the next {@link ensure}
   *   starts a fresh one against the new location. Continuing to execute project
   *   code against a path the table no longer names is the worse option.
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
      if (!domainSnapshotEquals(server.domain, fresh)) {
        this.logger.info(
          `[domain-supervisor] domain ${id} changed (${server.domain.name} @ ${server.domain.path} → ${fresh.name} @ ${fresh.path}) — restarting its worker`,
        );
        this.drop(id, server);
        continue;
      }
      if (server.state === "gone" || server.state === "failed") {
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
