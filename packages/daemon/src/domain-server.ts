/**
 * Supervision of one domain worker.
 *
 * Same shape as `site-server.ts` — spawn, handshake, connect an MCP client,
 * detect death, restart under `restart-policy.ts` — with the differences that
 * matter for a domain:
 *
 * - **The link is abstract.** This class never names `Worker`. It holds a
 *   {@link DomainLink}, which is a Bun Worker today and a socket to another host
 *   when the domain grows a `host`. Everything below is written to survive that
 *   substitution: no synchronous call-and-return, no shared references, no
 *   assumption that a message arrives in the same tick it was sent.
 * - **A restart re-reads the database.** The worker's binding is a copy of a
 *   `domains` row, and a copy can go stale while the worker is down (renamed,
 *   moved, deleted). So the restart path resolves the row again rather than
 *   replaying the snapshot it started with. This is also the answer to "what
 *   state survives a restart": nothing the worker held in memory. State that
 *   must survive belongs in the database, because a restart and a move to
 *   another host are the same event from the worker's point of view.
 * - **A deleted domain is not restarted.** A worker whose domain row vanished
 *   has nothing to serve; it goes to `gone` and the supervisor reaps it. That is
 *   what makes "a domain removed loses its worker" true even when the removal
 *   races a crash.
 * - **In-flight requests are rejected, never abandoned.** Closing the client on
 *   the crash path is what rejects them; a caller gets a typed failure instead
 *   of a promise that never settles.
 */

import {
  AGENT_PROTOCOL_VERSION,
  type DomainReadyMessage,
  type DomainSnapshot,
  type DomainWorkerMessage,
  type Logger,
  ProtocolVersionMismatchError,
  assertDomainIdentity,
  consoleLogger,
  domainInitMessage,
  domainRestartRequired,
  isRemoteDomain,
} from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeClientWithTimeout } from "./close-timeout";
import type { DomainLink, DomainLinkFactory } from "./domain-link";
import {
  DEFAULT_RESTART_POLICY,
  type RestartPolicy,
  getBackoffDelay,
  maxAttempts,
  shouldRestart,
} from "./restart-policy";
import { safeSetTimeout } from "./safe-timers";

/** Handshake budget: how long a worker has to answer `init` with `ready`. */
export const DOMAIN_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Default budget for one tool call into a domain worker. */
export const DOMAIN_CALL_TIMEOUT_MS = 30_000;

/**
 * Lifecycle of one domain worker.
 *
 * `restarting` and `gone` are distinct on purpose: the first is "try again in a
 * moment", the second is "this domain no longer exists". A caller that cannot
 * tell them apart retries forever against a domain that was deleted.
 */
export type DomainWorkerState = "stopped" | "starting" | "running" | "restarting" | "failed" | "gone";

/** Resolves a domain id to its current row, or `null` if the domain is gone. */
export type DomainResolver = (domainId: number) => DomainSnapshot | null;

export interface DomainServerOptions {
  linkFactory: DomainLinkFactory;
  /** Re-read the `domains` row. Called on every restart, so a rename or a move is picked up. */
  resolveDomain: DomainResolver;
  daemonId?: string | null;
  clientFactory?: () => Client;
  logger?: Logger;
  restartPolicy?: RestartPolicy;
  handshakeTimeoutMs?: number;
  callTimeoutMs?: number;
  /** The worker gave up: crash budget exhausted or every restart attempt failed. */
  onPermanentlyFailed?: (reason: string) => void;
  /** The domain row disappeared while the worker was running. The supervisor reaps it. */
  onGone?: () => void;
  /** Any successful interaction — lets the daemon reset its idle timer. */
  onActivity?: () => void;
}

/**
 * Thrown when a domain worker cannot serve a request right now.
 *
 * `retryable` is the distinction callers need and the one prose keeps losing: a
 * restarting worker will be back, a `gone` domain will not.
 */
export class DomainWorkerUnavailableError extends Error {
  readonly domainId: number;
  readonly state: DomainWorkerState;
  readonly retryable: boolean;

  constructor(domainId: number, state: DomainWorkerState, detail?: string) {
    super(
      `Domain ${domainId} worker is ${state}${detail ? `: ${detail}` : ""}${
        state === "gone" ? " — the domain no longer exists" : ""
      }`,
    );
    this.name = "DomainWorkerUnavailableError";
    this.domainId = domainId;
    this.state = state;
    this.retryable = state === "starting" || state === "restarting" || state === "stopped";
  }
}

/**
 * Thrown when a server is stopped while one of its own async steps is in flight.
 *
 * `stop()` is terminal, and the hazard is that `start()` spans two awaits: a
 * handshake and an MCP connect. Without a re-check between them a resolving
 * `start()` resurrects the client `stop()` had nulled, flips the state back to
 * `running`, and `call()` sails past its fail-fast gate into a terminated
 * worker — after `stopAll()` has returned claiming everything is stopped.
 */
export class DomainServerStoppedError extends Error {
  constructor(domainId: number, during: string) {
    super(`Domain ${domainId} worker was stopped during ${during}`);
    this.name = "DomainServerStoppedError";
  }
}

/** Thrown when a domain that lives on another host is asked for a worker in this process. */
export class RemoteDomainError extends Error {
  readonly domain: DomainSnapshot;

  constructor(domain: DomainSnapshot) {
    super(
      `Domain "${domain.name}" lives on host ${JSON.stringify(domain.host)}; a worker for it runs there, not here. Routing to a remote domain server is not implemented yet (epic B).`,
    );
    this.name = "RemoteDomainError";
    this.domain = domain;
  }
}

export class DomainServer {
  private link: DomainLink | null = null;
  private client: Client | null = null;
  private snapshot: DomainSnapshot;
  private workerState: DomainWorkerState = "stopped";
  private failureReason: string | null = null;
  private readonly crashTimestamps: number[] = [];
  private restartInProgress = false;
  private pendingCrashReason: string | null = null;
  private stopped = false;
  /** Settles an in-flight handshake early when `stop()` lands. */
  private abortHandshake: ((err: Error) => void) | null = null;

  private readonly logger: Logger;
  private readonly restartPolicy: RestartPolicy;
  private readonly handshakeTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly clientFactory: () => Client;

  constructor(
    domain: DomainSnapshot,
    private readonly opts: DomainServerOptions,
  ) {
    if (isRemoteDomain(domain)) throw new RemoteDomainError(domain);
    this.snapshot = domain;
    this.logger = opts.logger ?? consoleLogger;
    this.restartPolicy = opts.restartPolicy ?? DEFAULT_RESTART_POLICY;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DOMAIN_HANDSHAKE_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? DOMAIN_CALL_TIMEOUT_MS;
    this.clientFactory =
      opts.clientFactory ?? (() => new Client({ name: `mcp-cli/_domain:${this.snapshot.name}`, version: "0.1.0" }));
  }

  /** The domain row this worker is bound to, as of the last (re)start. */
  get domain(): DomainSnapshot {
    return this.snapshot;
  }

  get state(): DomainWorkerState {
    return this.workerState;
  }

  /** Why the worker is `failed`, when it is. */
  get reason(): string | null {
    return this.failureReason;
  }

  /** Crashes counted inside the policy's rolling window. */
  get crashCount(): number {
    return this.crashTimestamps.length;
  }

  /**
   * Adopt a renamed domain row without disturbing the running worker.
   *
   * A rename changes the label, not the binding, so the worker keeps running and
   * the supervisor's view of it is updated in place. The worker's own copy stays
   * stale until it next restarts, which is harmless: inside the worker `name` is
   * only ever a log line or the MCP handshake identity string.
   *
   * **Throws if the binding actually changed.** The whole hazard here is a
   * caller reaching for the cheap path to avoid a restart it does not want to
   * pay for, and silently rebinding a live worker to a different location. That
   * is a guard rather than a doc sentence because a doc sentence is exactly what
   * failed the first time.
   */
  adoptRename(fresh: DomainSnapshot): void {
    if (domainRestartRequired(this.snapshot, fresh)) {
      throw new Error(
        `adoptRename called with a changed binding for domain ${this.snapshot.id} (${this.snapshot.host ?? "local"}:${this.snapshot.path} → ${fresh.host ?? "local"}:${fresh.path}); a moved domain needs a new worker, not a renamed one`,
      );
    }
    this.snapshot = fresh;
  }

  /**
   * Bring the worker up: create the link, send `init`, wait for `ready`, connect
   * the MCP client. Throws (leaving the server `failed`) if any step fails.
   */
  async start(): Promise<void> {
    if (this.link) throw new Error(`DomainServer.start() called while domain ${this.snapshot.id} is already running`);
    this.stopped = false;
    this.failureReason = null;
    this.workerState = this.workerState === "restarting" ? "restarting" : "starting";

    const link = this.opts.linkFactory(this.snapshot);
    this.link = link;

    try {
      await this.handshake(link);
      this.assertStillWanted("the worker handshake");
      const client = this.clientFactory();
      await this.connectClient(client, link);
      this.assertStillWanted("the MCP handshake");
      this.client = client;
    } catch (err) {
      await this.teardownLink();
      // `stopped` outranks everything: a server nobody is trying to keep is not
      // `failed` (which reads as "this will never work" with `retryable: false`)
      // and not `restarting` (which reads as "it is coming back", forever).
      // A failed attempt *during* a restart is still "restarting" — reporting
      // `failed` between backoff attempts would tell a concurrent caller the
      // worker is not coming back when it is about to be tried again.
      this.workerState = this.stopped ? "stopped" : this.restartInProgress ? "restarting" : "failed";
      this.failureReason = err instanceof Error ? err.message : String(err);
      throw err;
    }

    // Only now does link failure mean "a running worker died" rather than "a
    // start attempt failed", which the caller is already handling.
    //
    // `notified` is not belt-and-braces: a link can report its death more than
    // once (a Worker can emit several `error` events for one crash, a socket can
    // surface both an error and a close). Without it the duplicate is queued as
    // a pending crash and replayed *after* the restart succeeds — killing the
    // healthy worker that just came up. One link dies once.
    link.onControl = (message: DomainWorkerMessage) => {
      if (message.type !== "error") return;
      // A running worker complaining about itself. Not fatal on its own — the
      // link is still up — but it must not vanish, which is what happened while
      // `onControl` stayed null from the end of the handshake onward.
      this.logger.error(`[domain-server:${this.snapshot.name}] worker reported an error: ${message.message}`);
    };

    let notified = false;
    link.onFailure = (reason) => {
      // No `stopped` check here: handleCrash already returns immediately when
      // stopped, so a second one is a guard no test can tell from its absence.
      if (this.link !== link || notified) return;
      notified = true;
      void this.handleCrash(reason);
    };
    this.workerState = "running";
    this.opts.onActivity?.();
  }

  /**
   * Throw if `stop()` landed while an async step was in flight.
   *
   * Called after every await in {@link start}. A boolean checked once at the top
   * is not a guard when the thing it guards spans two round trips.
   */
  private assertStillWanted(during: string): void {
    if (this.stopped) throw new DomainServerStoppedError(this.snapshot.id, during);
  }

  /** Stop the worker for good. Idempotent, and terminal — nothing moves it out of `stopped`. */
  async stop(): Promise<void> {
    this.stopped = true;
    // Settle a handshake still in flight rather than leaving its timer live and
    // its promise unsettled for the full budget past a resolved stop().
    this.abortHandshake?.(new DomainServerStoppedError(this.snapshot.id, "the worker handshake"));
    await closeClientWithTimeout(this.client);
    await this.teardownLink();
    this.workerState = "stopped";
    this.crashTimestamps.length = 0;
  }

  /**
   * Call a tool on the worker.
   *
   * Fails fast with a typed, `retryable`-tagged error when the worker is not
   * running — a caller must not have to distinguish "starting" from "deleted" by
   * reading an error string. Bounded by `callTimeoutMs` because a link that has
   * become a socket can stall without ever failing.
   */
  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const client = this.client;
    if (this.workerState !== "running" || !client) {
      throw new DomainWorkerUnavailableError(this.snapshot.id, this.workerState, this.failureReason ?? undefined);
    }
    const result = await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
      timeout: timeoutMs ?? this.callTimeoutMs,
    });
    this.opts.onActivity?.();
    return result;
  }

  // ── Startup steps ──

  private async handshake(link: DomainLink): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortHandshake = null;
        // `onControl` is reinstalled by the caller on success (see start()) —
        // `error` is a protocol message the worker may post at any time, and
        // dropping it silently after the handshake is how a worker's own
        // complaint about itself goes unheard.
        link.onControl = null;
        link.onFailure = null;
        fn();
      };
      this.abortHandshake = (err: Error) => finish(() => reject(err));

      const timer = safeSetTimeout(() => {
        finish(() =>
          reject(new Error(`Domain worker startup timeout (${this.handshakeTimeoutMs}ms) for "${this.snapshot.name}"`)),
        );
      }, this.handshakeTimeoutMs);

      link.onControl = (message: DomainWorkerMessage) => {
        if (message.type === "ready") {
          finish(() => {
            try {
              this.verifyReady(message);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          return;
        }
        finish(() => reject(new Error(`Domain worker init failed for "${this.snapshot.name}": ${message.message}`)));
      };

      link.onFailure = (reason) => {
        finish(() => reject(new Error(`Domain worker link failed for "${this.snapshot.name}": ${reason}`)));
      };

      link.postControl(domainInitMessage(this.snapshot, this.opts.daemonId ?? null));
    });
  }

  private verifyReady(ready: DomainReadyMessage): void {
    const supported = ready.supported_protocol_version;
    if (typeof supported === "number" && supported !== AGENT_PROTOCOL_VERSION) {
      throw new ProtocolVersionMismatchError(AGENT_PROTOCOL_VERSION, supported);
    }
    assertDomainIdentity(this.snapshot.id, ready);
  }

  private async connectClient(client: Client, link: DomainLink): Promise<void> {
    let connected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(link.transport).then(() => {
          connected = true;
        }),
        new Promise<never>((_, reject) => {
          timer = safeSetTimeout(() => {
            if (connected) return;
            reject(
              new Error(`Domain MCP handshake timeout (${this.handshakeTimeoutMs}ms) for "${this.snapshot.name}"`),
            );
          }, this.handshakeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async teardownLink(): Promise<void> {
    const link = this.link;
    this.link = null;
    this.client = null;
    if (!link) return;
    link.onControl = null;
    link.onFailure = null;
    try {
      await link.close();
    } catch (err) {
      this.logger.warn(`[domain-server:${this.snapshot.name}] error closing link: ${err}`);
    }
  }

  // ── Crash handling ──

  private async handleCrash(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.restartInProgress) {
      this.pendingCrashReason = reason;
      return;
    }
    this.restartInProgress = true;
    this.workerState = "restarting";
    this.logger.error(`[domain-server:${this.snapshot.name}] worker died: ${reason}`);

    // Closing the client is what rejects requests that were in flight when the
    // worker died. Without it they hang until their own timeout, and a caller
    // cannot tell a slow domain from a dead one.
    await closeClientWithTimeout(this.client);
    await this.teardownLink();

    try {
      // The domain may have been removed while the worker was dying. Restarting
      // a worker for a row that no longer exists is how a deleted project keeps
      // executing.
      const fresh = this.opts.resolveDomain(this.snapshot.id);
      if (!fresh) {
        this.logger.warn(
          `[domain-server:${this.snapshot.name}] domain ${this.snapshot.id} no longer exists — not restarting`,
        );
        this.stopped = true;
        this.workerState = "gone";
        this.opts.onGone?.();
        return;
      }
      if (isRemoteDomain(fresh)) {
        this.logger.warn(
          `[domain-server:${this.snapshot.name}] domain moved to host ${fresh.host} — a local worker no longer serves it`,
        );
        this.stopped = true;
        this.workerState = "gone";
        this.opts.onGone?.();
        return;
      }
      this.snapshot = fresh;

      if (!shouldRestart(this.crashTimestamps, this.restartPolicy)) {
        this.giveUp(
          `${this.crashTimestamps.length} crashes in ${this.restartPolicy.crashWindowMs / 1000}s — giving up auto-restart`,
        );
        return;
      }

      const totalAttempts = maxAttempts(this.restartPolicy);
      let lastErr: unknown;
      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        if (attempt > 0) {
          const delay = getBackoffDelay(attempt, this.restartPolicy.backoffDelaysMs);
          this.logger.warn(
            `[domain-server:${this.snapshot.name}] retry ${attempt}/${totalAttempts - 1} after ${delay}ms...`,
          );
          await Bun.sleep(delay);
        }
        if (this.stopped) {
          this.logger.info(`[domain-server:${this.snapshot.name}] stopped during restart backoff — aborting`);
          return;
        }
        try {
          await this.start();
          this.logger.info(`[domain-server:${this.snapshot.name}] worker restarted`);
          return;
        } catch (err) {
          lastErr = err;
          this.logger.error(`[domain-server:${this.snapshot.name}] restart attempt ${attempt + 1} failed: ${err}`);
        }
      }
      this.giveUp(`all ${totalAttempts} restart attempts failed (last: ${lastErr})`);
    } finally {
      this.restartInProgress = false;
      if (this.pendingCrashReason !== null && !this.stopped) {
        const pending = this.pendingCrashReason;
        this.pendingCrashReason = null;
        await this.handleCrash(pending);
      }
    }
  }

  private giveUp(reason: string): void {
    this.logger.error(`[domain-server:${this.snapshot.name}] ${reason}`);
    this.stopped = true;
    this.workerState = "failed";
    this.failureReason = reason;
    this.opts.onPermanentlyFailed?.(reason);
  }
}
