import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMethod, MailMessage } from "@mcp-cli/core";
import { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";
import { MailHandlers } from "./mail";

/**
 * These run against a **real** `StateDb`, not a hand-rolled mock.
 *
 * The partition being tested is enforced by SQL predicates and by the domains table's
 * resolution rule; a mock reimplements both, and a mock that reimplements them slightly
 * wrong reports a passing partition test while the real query leaks. The suite is the
 * acceptance criteria of #3038 executed end-to-end from the IPC boundary down.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  map: Map<IpcMethod, RequestHandler>;
  db: StateDb;
  /** cwd inside domain `alpha`. */
  alpha: string;
  /** cwd inside domain `beta`. */
  beta: string;
  /** cwd inside no domain at all. */
  nowhere: string;
}

function fixture(opts: { domains?: boolean; isDraining?: () => boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mcx-mail-handlers-"));
  dirs.push(root);
  const db = new StateDb(join(root, "mcx.db"));

  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  const nowhere = join(root, "nowhere");
  for (const p of [alpha, beta, nowhere]) mkdirSync(p, { recursive: true });

  if (opts.domains !== false) {
    db.createDomain("alpha", alpha);
    db.createDomain("beta", beta);
  }

  const map = new Map<IpcMethod, RequestHandler>();
  new MailHandlers(db, null, opts.isDraining ?? (() => false)).register(map);
  return { map, db, alpha, beta, nowhere };
}

const CTX = {} as never;

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

async function send(f: Fixture, params: Record<string, unknown>): Promise<number> {
  const r = (await invoke(f.map, "sendMail")(params, CTX)) as { id: number };
  return r.id;
}

async function read(f: Fixture, params: Record<string, unknown>): Promise<MailMessage[]> {
  const r = (await invoke(f.map, "readMail")(params, CTX)) as { messages: MailMessage[] };
  return r.messages;
}

describe("MailHandlers — basics", () => {
  test("sendMail inserts and returns an id", async () => {
    const f = fixture();
    expect(await send(f, { sender: "alice", recipient: "bob", subject: "hi", body: "hello", cwd: f.alpha })).toBe(1);
    expect(await send(f, { sender: "alice", recipient: "carol", cwd: f.alpha })).toBe(2);
  });

  test("readMail filters by recipient and by unread", async () => {
    const f = fixture();
    await send(f, { sender: "a", recipient: "bob", cwd: f.alpha });
    await send(f, { sender: "a", recipient: "carol", cwd: f.alpha });
    expect(await read(f, { cwd: f.alpha })).toHaveLength(2);
    expect(await read(f, { recipient: "bob", cwd: f.alpha })).toHaveLength(1);

    await invoke(f.map, "markRead")({ id: 1, cwd: f.alpha }, CTX);
    const unread = await read(f, { unreadOnly: true, cwd: f.alpha });
    expect(unread.map((m) => m.id)).toEqual([2]);
  });

  test("waitForMail returns an available message and marks it read", async () => {
    const f = fixture();
    await send(f, { sender: "a", recipient: "b", body: "urgent", cwd: f.alpha });
    const first = (await invoke(f.map, "waitForMail")({ recipient: "b", timeout: 5, cwd: f.alpha }, CTX)) as {
      message: MailMessage | null;
    };
    expect(first.message?.body).toBe("urgent");

    const second = (await invoke(f.map, "waitForMail")({ recipient: "b", timeout: 1, cwd: f.alpha }, CTX)) as {
      message: MailMessage | null;
    };
    expect(second.message).toBeNull();
  });

  test("waitForMail returns null immediately when draining", async () => {
    const f = fixture({ isDraining: () => true });
    await send(f, { sender: "a", recipient: "b", cwd: f.alpha });
    const r = (await invoke(f.map, "waitForMail")({ recipient: "b", timeout: 30, cwd: f.alpha }, CTX)) as {
      message: MailMessage | null;
    };
    expect(r.message).toBeNull();
  });

  test("replyToMail threads back to the sender with a Re: subject", async () => {
    const f = fixture();
    await send(f, { sender: "alice", recipient: "bob", subject: "hello", cwd: f.alpha });
    await invoke(f.map, "replyToMail")({ id: 1, sender: "bob", body: "hi back", cwd: f.alpha }, CTX);

    const alices = await read(f, { recipient: "alice", cwd: f.alpha });
    expect(alices[0].subject).toBe("Re: hello");
    expect(alices[0].replyTo).toBe(1);
  });

  test("replyToMail honours an explicit subject", async () => {
    const f = fixture();
    await send(f, { sender: "alice", recipient: "bob", subject: "topic", cwd: f.alpha });
    await invoke(f.map, "replyToMail")({ id: 1, sender: "bob", body: "r", subject: "custom", cwd: f.alpha }, CTX);
    expect((await read(f, { recipient: "alice", cwd: f.alpha }))[0].subject).toBe("custom");
  });

  test("replyToMail throws INVALID_PARAMS for a missing id", async () => {
    const f = fixture();
    await expect(
      invoke(f.map, "replyToMail")({ id: 99, sender: "bob", body: "r", cwd: f.alpha }, CTX),
    ).rejects.toMatchObject({ message: "Mail message 99 not found" });
  });
});

// The four acceptance criteria of #3038, verbatim. Each fails against the pre-#3038
// handlers, which passed no domain to the DB and predicated on none.
describe("MailHandlers — domain partitioning (#3038 acceptance)", () => {
  test("two domains each have an orchestrator mailbox; a bare send from X is invisible in Y", async () => {
    const f = fixture();
    await send(f, { sender: "worker", recipient: "orchestrator", subject: "alpha work", cwd: f.alpha });
    await send(f, { sender: "worker", recipient: "orchestrator", subject: "beta work", cwd: f.beta });

    expect((await read(f, { recipient: "orchestrator", cwd: f.alpha })).map((m) => m.subject)).toEqual(["alpha work"]);
    expect((await read(f, { recipient: "orchestrator", cwd: f.beta })).map((m) => m.subject)).toEqual(["beta work"]);
  });

  test("orchestrator@beta from inside alpha delivers to beta's orchestrator", async () => {
    const f = fixture();
    await send(f, { sender: "worker", recipient: "orchestrator@beta", subject: "cross", cwd: f.alpha });

    // Landed in beta, not alpha.
    expect(await read(f, { recipient: "orchestrator", cwd: f.alpha })).toHaveLength(0);
    const inBeta = await read(f, { recipient: "orchestrator", cwd: f.beta });
    expect(inBeta.map((m) => m.subject)).toEqual(["cross"]);
    // ...and carries a return address, so the reply can get home.
    expect(inBeta[0].sender).toBe("worker@alpha");
  });

  test("orchestrator@nosuchdomain errors at send time — nothing is written", async () => {
    const f = fixture();
    await expect(
      invoke(f.map, "sendMail")({ sender: "worker", recipient: "orchestrator@nosuchdomain", cwd: f.alpha }, CTX),
    ).rejects.toThrow(/unknown domain/);

    expect(await read(f, { cwd: f.alpha })).toHaveLength(0);
    expect(await read(f, { cwd: f.beta })).toHaveLength(0);
  });

  test("waitForMail in alpha does not wake on beta's traffic", async () => {
    const f = fixture();
    await send(f, { sender: "worker", recipient: "orchestrator", subject: "beta only", cwd: f.beta });

    const r = (await invoke(f.map, "waitForMail")({ recipient: "orchestrator", timeout: 1, cwd: f.alpha }, CTX)) as {
      message: MailMessage | null;
    };
    expect(r.message).toBeNull();
    // Beta's message is still unread — alpha's wait consumed nothing.
    expect(await read(f, { recipient: "orchestrator", unreadOnly: true, cwd: f.beta })).toHaveLength(1);
  });
});

describe("MailHandlers — failure directions", () => {
  test("an unscoped call is refused rather than served from a guessed partition", async () => {
    const f = fixture();
    await send(f, { sender: "a", recipient: "b", cwd: f.alpha });
    for (const [method, params] of [
      ["sendMail", { sender: "a", recipient: "b" }],
      ["readMail", {}],
      ["waitForMail", { recipient: "b", timeout: 1 }],
      ["replyToMail", { id: 1, sender: "b", body: "r" }],
      ["markRead", { id: 1 }],
    ] as const) {
      await expect(invoke(f.map, method)(params, CTX)).rejects.toThrow(/domain scope/);
    }
  });

  test("a cwd outside every domain is refused once any domain exists", async () => {
    const f = fixture();
    await expect(invoke(f.map, "sendMail")({ sender: "a", recipient: "b", cwd: f.nowhere }, CTX)).rejects.toThrow(
      /outside every registered domain/,
    );
  });

  test("a cwd outside every domain is the unassigned partition when none are registered", async () => {
    const f = fixture({ domains: false });
    // The escape hatch: `mcx mail … boss` works before anyone runs `mcx domain add`.
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "blocked", cwd: f.nowhere });
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject)).toEqual(["blocked"]);
  });

  test("a cross-domain send from the unassigned partition is refused — no return address", async () => {
    const f = fixture();
    await expect(
      invoke(f.map, "sendMail")({ sender: "a", recipient: "orchestrator@alpha", domain: undefined, cwd: f.beta }, CTX),
    ).resolves.toBeDefined(); // beta → alpha is fine: beta has a name.

    const g = fixture({ domains: false });
    // With no domains at all there is nothing to address, and naming one errors.
    await expect(
      invoke(g.map, "sendMail")({ sender: "a", recipient: "orchestrator@alpha", cwd: g.nowhere }, CTX),
    ).rejects.toThrow(/unknown domain/);
  });

  test("markRead cannot mark another domain's message read", async () => {
    const f = fixture();
    const id = await send(f, { sender: "w", recipient: "orchestrator", cwd: f.alpha });
    await invoke(f.map, "markRead")({ id, cwd: f.beta }, CTX);
    expect(await read(f, { recipient: "orchestrator", unreadOnly: true, cwd: f.alpha })).toHaveLength(1);
  });

  test("replyToMail cannot reply to another domain's message", async () => {
    const f = fixture();
    const id = await send(f, { sender: "w", recipient: "orchestrator", cwd: f.alpha });
    await expect(invoke(f.map, "replyToMail")({ id, sender: "x", body: "r", cwd: f.beta }, CTX)).rejects.toThrow(
      /not found/,
    );
  });

  test("a reply to a cross-domain message routes back across the boundary", async () => {
    const f = fixture();
    await send(f, { sender: "worker", recipient: "orchestrator@beta", subject: "ping", cwd: f.alpha });
    const inBeta = await read(f, { recipient: "orchestrator", cwd: f.beta });

    await invoke(f.map, "replyToMail")({ id: inBeta[0].id, sender: "orchestrator", body: "pong", cwd: f.beta }, CTX);

    // The reply landed back in alpha, addressed to the original local part.
    const back = await read(f, { recipient: "worker", cwd: f.alpha });
    expect(back).toHaveLength(1);
    expect(back[0].body).toBe("pong");
    expect(back[0].sender).toBe("orchestrator@beta");
    // ...and did NOT land in beta.
    expect(await read(f, { recipient: "worker", cwd: f.beta })).toHaveLength(0);
  });

  test("-d overrides cwd, and an unknown -d is refused", async () => {
    const f = fixture();
    await send(f, { sender: "w", recipient: "orchestrator", subject: "via -d", cwd: f.alpha, domain: "beta" });
    expect(await read(f, { recipient: "orchestrator", cwd: f.alpha })).toHaveLength(0);
    expect((await read(f, { recipient: "orchestrator", cwd: f.alpha, domain: "beta" }))[0].subject).toBe("via -d");

    await expect(invoke(f.map, "readMail")({ cwd: f.alpha, domain: "nosuchdomain" }, CTX)).rejects.toThrow(
      /unknown domain/,
    );
  });

  test("a sender cannot forge another domain", async () => {
    const f = fixture();
    await expect(
      invoke(f.map, "sendMail")({ sender: "spoof@beta", recipient: "orchestrator", cwd: f.alpha }, CTX),
    ).rejects.toThrow(/may only be qualified/);
  });
});
