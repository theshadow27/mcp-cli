/**
 * Trouter push-stream watcher (the testable core).
 *
 * This class drives the socket.io-0.9 Trouter handshake and turns the resulting
 * `messaging`-flow events into normalised {@link NormalisedSiteMessage} records
 * on the daemon event bus. It performs **no I/O of its own** — the WebSocket,
 * the registrar HTTP calls, the credential lookup, the event-bus publish, the
 * cursor store and the REST gap-fill are all injected. That is what lets the
 * unit tests drive it with synthetic socket.io frames and fakes, with zero
 * network.
 *
 * The handshake implemented here is the one validated live end-to-end
 * out-of-band (see docs/watch.md § "The verified handshake"):
 *
 *   1. connect  wss://<pool>-t.trouter…/v4/c?…&epid=<OUR fresh guid>&…
 *   2. RX 1::               → immediately TX user.authenticate (connectparams: null)
 *   3. RX trouter.connected → capture surl, POST registrar registration (our own id)
 *   4. RX trouter.message_loss → ACK trouter.processed_message_loss (echo args)
 *   5. RX 3:::{…/messaging}  → parse body, publish, ACK 3:::{id,status:200}
 *   6. heartbeats: 2:: → 2:: ;  app ping 5:N+::{ping} → 6:::N+["pong"]
 *   7. stop: DELETE registrar registration
 *
 * HAZARD: always OUR OWN fresh epid + registrationId; never reuse a human tab's,
 * never purge another endpoint's subscriptions. The pool is dynamic — the surl
 * to register always comes from the `trouter.connected` frame, never hardcoded.
 */

import {
  TROUTER_PACKET,
  encodeAck,
  encodeEvent,
  encodeHeartbeat,
  encodeMessage,
  isDisconnect,
  parseEventFrame,
  parseFrame,
} from "./trouter-codec";
import { type NormalisedSiteMessage, normaliseTrouterMessage } from "./trouter-normalize";

export interface TrouterSocket {
  send(frame: string): void;
  close(): void;
}

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: (reason: string) => void;
  onError: (err: unknown) => void;
}

/** Opens a WebSocket to `url`, wiring the four handlers. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => TrouterSocket;

export interface TrouterCredential {
  bearer: string;
  /** Our own MRI (`8:orgid:<oid>`), for is_me / mentions_me derivation. */
  mri?: string;
}

export interface TrouterRegistrar {
  register(input: { surl: string; registrationId: string; credential: TrouterCredential }): Promise<{ status: number }>;
  deregister(input: { registrationId: string; credential: TrouterCredential }): Promise<{ status: number }>;
}

export interface CursorStore {
  get(site: string, thread: string): Promise<string | null>;
  set(site: string, thread: string, version: string): Promise<void>;
}

export type PublishFn = (record: NormalisedSiteMessage) => void;

/** REST backfill for one thread from `sinceVersion` (exclusive) forward. */
export type GapFillFn = (site: string, thread: string, sinceVersion: string) => Promise<NormalisedSiteMessage[]>;

export interface TrouterWatcherDeps {
  site: string;
  socketFactory: SocketFactory;
  registrar: TrouterRegistrar;
  credentialProvider: () => Promise<TrouterCredential | null>;
  /** Builds the full `wss://…/v4/c?…` connect URL, given our fresh connection identifiers. */
  buildConnectUrl: (ids: { epid: string; corId: string; conNum: string }) => Promise<string>;
  publish: PublishFn;
  cursor: CursorStore;
  gapFill: GapFillFn;
  /** Fresh GUID generator (crypto.randomUUID in production). */
  genId?: () => string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Injectable timer, so tests never depend on wall-clock scheduling. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export type WatcherState = "idle" | "connecting" | "authenticating" | "registering" | "live" | "closed" | "stopped";

/** How long a registrar registration is good for (seconds); we renew before this. */
const REGISTRATION_TTL_SEC = 3600;
/** Renew a little before expiry. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** Bounded exact-dedup window (id:version pairs already published this session). */
const SEEN_MAX = 5000;

export class TrouterWatcher {
  private readonly d: Required<Pick<TrouterWatcherDeps, "genId" | "now" | "log" | "setTimer" | "clearTimer">> &
    TrouterWatcherDeps;
  private socket: TrouterSocket | null = null;
  private state: WatcherState = "idle";
  private credential: TrouterCredential | null = null;
  private registrationId: string | null = null;
  private surl: string | null = null;
  private renewTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly watched = new Set<string>();
  private stopped = false;
  private reconnectAttempts = 0;

  constructor(deps: TrouterWatcherDeps) {
    this.d = {
      ...deps,
      genId: deps.genId ?? (() => crypto.randomUUID()),
      now: deps.now ?? Date.now,
      log: deps.log ?? (() => {}),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h)),
    };
  }

  getState(): WatcherState {
    return this.state;
  }

  /** Threads this watcher gap-fills on reconnect (the firehose publishes all threads regardless). */
  watchedThreads(): string[] {
    return [...this.watched];
  }

  addThreads(ids: string[]): void {
    for (const id of ids) this.watched.add(id);
  }

  status(): { site: string; state: WatcherState; registrationId: string | null; watched: number } {
    return {
      site: this.d.site,
      state: this.state,
      registrationId: this.registrationId,
      watched: this.watched.size,
    };
  }

  /** Open the socket and begin the handshake. Idempotent while already connecting/live. */
  async start(): Promise<void> {
    if (
      this.state === "connecting" ||
      this.state === "live" ||
      this.state === "authenticating" ||
      this.state === "registering"
    ) {
      return;
    }
    this.stopped = false;
    this.credential = await this.d.credentialProvider();
    if (!this.credential) {
      this.d.log(`[trouter:${this.d.site}] no credential available; will retry`);
      this.scheduleReconnect();
      return;
    }
    const ids = {
      epid: this.d.genId(),
      corId: this.d.genId(),
      conNum: `${this.d.now()}_0`,
    };
    const url = await this.d.buildConnectUrl(ids);
    this.state = "connecting";
    this.socket = this.d.socketFactory(url, {
      onOpen: () => this.d.log(`[trouter:${this.d.site}] socket open`),
      onMessage: (raw) => {
        void this.handleFrame(raw);
      },
      onClose: (reason) => this.handleClose(reason),
      onError: (err) => this.d.log(`[trouter:${this.d.site}] socket error: ${String(err)}`),
    });
  }

  /** Deregister our endpoint and close the socket. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer) this.d.clearTimer(this.renewTimer);
    if (this.reconnectTimer) this.d.clearTimer(this.reconnectTimer);
    this.renewTimer = null;
    this.reconnectTimer = null;
    if (this.registrationId && this.credential) {
      try {
        await this.d.registrar.deregister({ registrationId: this.registrationId, credential: this.credential });
      } catch (err) {
        this.d.log(`[trouter:${this.d.site}] deregister failed: ${String(err)}`);
      }
    }
    this.socket?.close();
    this.socket = null;
    this.state = "stopped";
  }

  private send(frame: string): void {
    this.socket?.send(frame);
  }

  private async handleFrame(raw: string): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) return;

    if (frame.type === TROUTER_PACKET.connect) {
      // 1:: — authenticate immediately, connectparams null on a cold connect.
      this.authenticate();
      return;
    }
    if (frame.type === TROUTER_PACKET.heartbeat) {
      this.send(encodeHeartbeat());
      return;
    }
    if (isDisconnect(frame)) {
      this.handleClose("server-disconnect");
      return;
    }
    if (frame.type === TROUTER_PACKET.event) {
      this.handleEvent(raw, frame.needsAck, frame.id);
      return;
    }
    if (frame.type === TROUTER_PACKET.message) {
      await this.handleMessage(frame.data);
      return;
    }
  }

  private authenticate(): void {
    if (!this.credential) return;
    this.state = "authenticating";
    this.send(
      encodeEvent("user.authenticate", [
        {
          headers: {
            Authorization: `Bearer ${this.credential.bearer}`,
            "X-MS-Migration": "True",
            "X-Ms-Test-User": "False",
          },
          connectparams: null,
        },
      ]),
    );
  }

  private handleEvent(raw: string, needsAck: boolean, id: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    const ev = parseEventFrame(frame);
    if (!ev) return;

    if (ev.name === "trouter.connected") {
      const arg = (ev.args[0] ?? {}) as { surl?: string };
      if (typeof arg.surl === "string") {
        this.surl = arg.surl;
        void this.registerEndpoint();
      }
      return;
    }
    if (ev.name === "trouter.message_loss") {
      // ACK the loss notice by echoing its args back as a processed event.
      this.send(encodeEvent("trouter.processed_message_loss", ev.args));
      return;
    }
    if (ev.name === "ping") {
      if (needsAck) this.send(encodeAck(id, ["pong"]));
      return;
    }
  }

  private async registerEndpoint(): Promise<void> {
    if (!this.surl || !this.credential) return;
    this.state = "registering";
    this.registrationId = this.d.genId();
    try {
      const res = await this.d.registrar.register({
        surl: this.surl,
        registrationId: this.registrationId,
        credential: this.credential,
      });
      if (res.status >= 200 && res.status < 300) {
        this.state = "live";
        this.reconnectAttempts = 0;
        this.scheduleRenew();
        void this.gapFillWatched();
      } else {
        this.d.log(`[trouter:${this.d.site}] registrar returned ${res.status}`);
        this.handleClose(`registrar-${res.status}`);
      }
    } catch (err) {
      this.d.log(`[trouter:${this.d.site}] registrar error: ${String(err)}`);
      this.handleClose("registrar-error");
    }
  }

  private async handleMessage(data: string): Promise<void> {
    let envelope: { id?: number; url?: string; body?: string };
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    // ACK the Trouter request-shaped envelope so it is not redelivered.
    if (typeof envelope.id === "number") {
      this.send(encodeMessage({ id: envelope.id, status: 200, headers: {}, body: "" }));
    }
    if (typeof envelope.url !== "string" || !envelope.url.includes("/messaging")) return;
    if (typeof envelope.body !== "string") return;

    let body: unknown;
    try {
      body = JSON.parse(envelope.body);
    } catch {
      return;
    }
    const record = normaliseTrouterMessage(body, this.d.site, this.credential?.mri);
    if (record) await this.emit(record);
  }

  /** Publish a record if not already seen; advance the per-thread cursor. */
  private async emit(record: NormalisedSiteMessage): Promise<void> {
    const key = `${record.thread}:${record.id}:${record.version}`;
    if (this.seen.has(key)) return;
    this.markSeen(key);
    this.d.publish(record);
    try {
      const last = await this.d.cursor.get(this.d.site, record.thread);
      if (last === null || record.version > last) {
        await this.d.cursor.set(this.d.site, record.thread, record.version);
      }
    } catch (err) {
      this.d.log(`[trouter:${this.d.site}] cursor update failed: ${String(err)}`);
    }
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > SEEN_MAX) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }

  /** After (re)connect, backfill each watched thread from its persisted cursor. */
  private async gapFillWatched(): Promise<void> {
    for (const thread of this.watched) {
      try {
        const last = await this.d.cursor.get(this.d.site, thread);
        const since = last ? incVersion(last) : "1";
        const records = await this.d.gapFill(this.d.site, thread, since);
        for (const r of records) await this.emit(r);
      } catch (err) {
        this.d.log(`[trouter:${this.d.site}] gap-fill failed for ${thread}: ${String(err)}`);
      }
    }
  }

  private scheduleRenew(): void {
    if (this.renewTimer) this.d.clearTimer(this.renewTimer);
    const ms = REGISTRATION_TTL_SEC * 1000 - RENEW_BEFORE_MS;
    this.renewTimer = this.d.setTimer(
      () => {
        void this.registerEndpoint();
      },
      Math.max(ms, RENEW_BEFORE_MS),
    );
  }

  private handleClose(reason: string): void {
    if (this.state === "stopped") return;
    this.state = "closed";
    this.socket = null;
    if (this.renewTimer) this.d.clearTimer(this.renewTimer);
    this.renewTimer = null;
    this.d.log(`[trouter:${this.d.site}] closed: ${reason}`);
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) this.d.clearTimer(this.reconnectTimer);
    this.reconnectAttempts += 1;
    // Capped exponential backoff: 1s, 2s, 4s … 30s.
    const backoff = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = this.d.setTimer(() => {
      void this.start();
    }, backoff);
  }
}

/** Increment an epoch-ms version string by one, for an exclusive gap-fill lower bound. */
export function incVersion(version: string): string {
  const n = Number(version);
  if (Number.isFinite(n)) return String(n + 1);
  return version;
}
