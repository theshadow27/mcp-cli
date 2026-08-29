import { describe, expect, test } from "bun:test";
import { pollUntil } from "../../../../test/harness";
import { parseEventFrame, parseFrame } from "./trouter-codec";
import type { NormalisedSiteMessage } from "./trouter-normalize";
import {
  type SocketHandlers,
  type TrouterCredential,
  TrouterWatcher,
  type TrouterWatcherDeps,
  incVersion,
} from "./trouter-worker";

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("expected non-null");
  return v;
}

const ME = "8:orgid:00000000-0000-0000-0000-00000000aaaa";
const OTHER = "8:orgid:00000000-0000-0000-0000-00000000bbbb";
const THREAD = "19:synthetic@thread.v2";

class FakeSocket {
  sent: string[] = [];
  closed = false;
  handlers: SocketHandlers;
  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  rx(raw: string): void {
    this.handlers.onMessage(raw);
  }
}

function messagingFrame(id: number, bodyObj: Record<string, unknown>): string {
  const envelope = { id, method: "POST", url: "/v4/f/flow/messaging", body: JSON.stringify(bodyObj) };
  return `3:::${JSON.stringify(envelope)}`;
}

function newMessageBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: "NewMessage",
    resourceLink: `https://x/conversations/${THREAD}/messages/1700000000001`,
    resource: {
      messagetype: "RichText/Html",
      id: "1700000000001",
      version: "1700000000001",
      composetime: "2026-08-28T10:00:00.000Z",
      from: `https://x/users/ME/contacts/${OTHER}`,
      imdisplayname: "Sender",
      to: THREAD,
      content: "<p>hi</p>",
      properties: {},
      ...(over.resource as Record<string, unknown>),
    },
    ...over,
  };
}

interface Harness {
  watcher: TrouterWatcher;
  socket: () => FakeSocket;
  published: NormalisedSiteMessage[];
  cursors: Map<string, string>;
  registerCalls: number;
  deregisterCalls: number;
}

function makeWatcher(
  opts: {
    credential?: TrouterCredential | null;
    registerStatus?: number;
    gapFill?: NormalisedSiteMessage[];
  } = {},
): Harness {
  let sock: FakeSocket | null = null;
  const published: NormalisedSiteMessage[] = [];
  const cursors = new Map<string, string>();
  const state = { registerCalls: 0, deregisterCalls: 0 };
  let idCounter = 0;

  const deps: TrouterWatcherDeps = {
    site: "teams",
    socketFactory: (_url, handlers) => {
      sock = new FakeSocket(handlers);
      return sock;
    },
    credentialProvider: async () => (opts.credential === undefined ? { bearer: "tok", mri: ME } : opts.credential),
    buildConnectUrl: async () => "wss://fake/v4/c",
    registrar: {
      register: async () => {
        state.registerCalls += 1;
        return { status: opts.registerStatus ?? 202 };
      },
      deregister: async () => {
        state.deregisterCalls += 1;
        return { status: 202 };
      },
    },
    publish: (r) => published.push(r),
    cursor: {
      get: async (site, thread) => cursors.get(`${site}:${thread}`) ?? null,
      set: async (site, thread, v) => {
        cursors.set(`${site}:${thread}`, v);
      },
    },
    gapFill: async () => opts.gapFill ?? [],
    genId: () => `id-${++idCounter}`,
    now: () => 1_700_000_000_000,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  };

  return {
    watcher: new TrouterWatcher(deps),
    socket: () => {
      if (!sock) throw new Error("socket not created");
      return sock;
    },
    published,
    cursors,
    get registerCalls() {
      return state.registerCalls;
    },
    get deregisterCalls() {
      return state.deregisterCalls;
    },
  };
}

function trouterConnected(surl: string): string {
  return `5:1::${JSON.stringify({ name: "trouter.connected", args: [{ id: "flow", surl }] })}`;
}

describe("TrouterWatcher handshake", () => {
  test("authenticates immediately on the connect ack with connectparams null", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("1::");
    const authFrame = h.socket().sent.find((f) => f.includes("user.authenticate"));
    expect(authFrame).toBeDefined();
    const ev = parseEventFrame(must(parseFrame(must(authFrame))));
    const arg = ev?.args[0] as { headers: { Authorization: string }; connectparams: null };
    expect(arg.headers.Authorization).toBe("Bearer tok");
    expect(arg.connectparams).toBeNull();
  });

  test("registers with our own registrationId on trouter.connected and goes live", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx(trouterConnected("https://pool/v4/f/flow/"));
    await pollUntil(() => h.watcher.getState() === "live");
    expect(h.registerCalls).toBe(1);
    expect(h.watcher.status().registrationId).toBe("id-3"); // epid, corId, then registrationId
  });

  test("acks and echoes a message_loss notice", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx(`5:2::${JSON.stringify({ name: "trouter.message_loss", args: [{ seq: 5 }] })}`);
    const echo = h.socket().sent.find((f) => f.includes("processed_message_loss"));
    expect(echo).toBeDefined();
    expect(parseEventFrame(must(parseFrame(must(echo))))?.args).toEqual([{ seq: 5 }]);
  });

  test("replies to a socket heartbeat", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("2::");
    expect(h.socket().sent).toContain("2::");
  });

  test("pongs an app-level ping that requires an ack", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx(`5:9+::${JSON.stringify({ name: "ping" })}`);
    expect(h.socket().sent).toContain('6:::9+["pong"]');
  });
});

describe("TrouterWatcher message delivery", () => {
  async function liveWatcher(opts: Parameters<typeof makeWatcher>[0] = {}): Promise<Harness> {
    const h = makeWatcher(opts);
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx(trouterConnected("https://pool/v4/f/flow/"));
    await pollUntil(() => h.watcher.getState() === "live");
    return h;
  }

  test("publishes and acks a new message, advancing the cursor", async () => {
    const h = await liveWatcher();
    h.socket().rx(messagingFrame(7, newMessageBody()));
    await pollUntil(() => h.published.length === 1);
    expect(h.published[0].kind).toBe("new");
    expect(h.published[0].thread).toBe(THREAD);
    expect(h.socket().sent.some((f) => f.startsWith("3:::") && f.includes('"status":200'))).toBe(true);
    expect(h.cursors.get(`teams:${THREAD}`)).toBe("1700000000001");
  });

  test("dedups by id+version", async () => {
    const h = await liveWatcher();
    h.socket().rx(messagingFrame(7, newMessageBody()));
    await pollUntil(() => h.published.length === 1);
    // Same message, new envelope id. The envelope is always ACKed (id:8), so wait
    // on that ACK rather than a fixed delay, then assert no second publish.
    h.socket().rx(messagingFrame(8, newMessageBody()));
    await pollUntil(() => h.socket().sent.some((f) => f.startsWith("3:::") && f.includes('"id":8')));
    expect(h.published.length).toBe(1);
  });

  test("re-emits an edit as a distinct version", async () => {
    const h = await liveWatcher();
    h.socket().rx(messagingFrame(7, newMessageBody()));
    await pollUntil(() => h.published.length === 1);
    h.socket().rx(
      messagingFrame(
        8,
        newMessageBody({
          resourceType: "MessageUpdate",
          resource: { version: "1700000009999", properties: { edittime: 1700000009999 } },
        }),
      ),
    );
    await pollUntil(() => h.published.length === 2);
    expect(h.published[1].kind).toBe("edited");
    expect(h.cursors.get(`teams:${THREAD}`)).toBe("1700000009999");
  });

  test("ignores a non-messaging envelope but still acks it", async () => {
    const h = await liveWatcher();
    const envelope = { id: 11, method: "POST", url: "/v4/f/flow/presence", body: "{}" };
    h.socket().rx(`3:::${JSON.stringify(envelope)}`);
    await pollUntil(() => h.socket().sent.some((f) => f.includes('"id":11')));
    expect(h.published.length).toBe(0);
  });
});

describe("TrouterWatcher gap-fill + lifecycle", () => {
  test("gap-fills watched threads from the cursor after going live", async () => {
    const gapRecord: NormalisedSiteMessage = {
      site: "teams",
      thread: THREAD,
      id: "1700000000050",
      version: "1700000000050",
      at: "2026-08-28T09:00:00.000Z",
      is_me: false,
      mentions_me: false,
      kind: "new",
      text: "missed while offline",
    };
    const h = makeWatcher({ gapFill: [gapRecord] });
    h.watcher.addThreads([THREAD]);
    h.cursors.set(`teams:${THREAD}`, "1700000000001");
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx(trouterConnected("https://pool/v4/f/flow/"));
    await pollUntil(() => h.published.length === 1);
    expect(h.published[0].id).toBe("1700000000050");
  });

  test("closes on a server disconnect frame", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx('0:::{"reason":"timeout"}');
    expect(h.watcher.getState()).toBe("closed");
  });

  test("stop() deregisters and closes the socket", async () => {
    const h = makeWatcher();
    await h.watcher.start();
    h.socket().rx("1::");
    h.socket().rx(trouterConnected("https://pool/v4/f/flow/"));
    await pollUntil(() => h.watcher.getState() === "live");
    await h.watcher.stop();
    expect(h.deregisterCalls).toBe(1);
    expect(h.socket().closed).toBe(true);
    expect(h.watcher.getState()).toBe("stopped");
  });

  test("schedules a reconnect (no credential) without throwing", async () => {
    const h = makeWatcher({ credential: null });
    await h.watcher.start();
    // No socket created; reconnect timer is a no-op stub, so state stays idle-ish.
    expect(() => h.watcher.status()).not.toThrow();
  });
});

describe("incVersion", () => {
  test("increments a numeric version string", () => {
    expect(incVersion("1700000000001")).toBe("1700000000002");
  });
  test("passes a non-numeric value through", () => {
    expect(incVersion("abc")).toBe("abc");
  });
});
