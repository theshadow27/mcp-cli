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

  /**
   * #3038 RED 1 — the merge-blocker, as a test.
   *
   * The `domains` table auto-populates on daemon boot from `mcx scope` sidecars, with no
   * user action. The previous revision only returned partition 0 when that table was
   * empty, so one auto-imported row made every mail call from anywhere else throw —
   * orphaning the whole mail history including the operator mailbox, with no recovery
   * command shipped.
   *
   * `f.nowhere` is outside `alpha` and `beta`. Mail from there must keep working.
   */
  test("a cwd outside every domain keeps working when other domains exist", async () => {
    const f = fixture();
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "blocked", cwd: f.nowhere });
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject)).toEqual(["blocked"]);
    // ...and it is still a partition: alpha cannot see it, and it cannot see alpha.
    await send(f, { sender: "w", recipient: "boss", subject: "alpha-only", cwd: f.alpha });
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject)).toEqual(["blocked"]);
    expect((await read(f, { recipient: "boss", cwd: f.alpha })).map((m) => m.subject)).toEqual(["alpha-only"]);
  });

  test("the same works before any domain is registered — the escape hatch either way", async () => {
    const f = fixture({ domains: false });
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "blocked", cwd: f.nowhere });
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject)).toEqual(["blocked"]);
  });

  /** Partition 0 is addressable by name, so mail stranded there is recoverable. */
  test("partition 0 is reachable by -d _ from inside a registered domain", async () => {
    const f = fixture();
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "stranded", cwd: f.nowhere });
    // A caller sitting inside `alpha` can still reach it, which is the recovery path.
    expect((await read(f, { recipient: "boss", cwd: f.alpha, domain: "_" })).map((m) => m.subject)).toEqual([
      "stranded",
    ]);
  });

  test("partition 0 can send across a boundary and receive the reply", async () => {
    const f = fixture();
    await send(f, { sender: "worker", recipient: "orchestrator@alpha", subject: "ping", cwd: f.nowhere });

    const inAlpha = await read(f, { recipient: "orchestrator", cwd: f.alpha });
    expect(inAlpha.map((m) => m.subject)).toEqual(["ping"]);
    expect(inAlpha[0].sender).toBe("worker@_"); // a real return address

    await invoke(f.map, "replyToMail")({ id: inAlpha[0].id, sender: "orchestrator", body: "pong", cwd: f.alpha }, CTX);
    const back = await read(f, { recipient: "worker", cwd: f.nowhere });
    expect(back.map((m) => m.body)).toEqual(["pong"]);
    expect(back[0].sender).toBe("orchestrator@alpha");
    // The reply did NOT stay in alpha.
    expect(await read(f, { recipient: "worker", cwd: f.alpha })).toHaveLength(0);
  });

  /** #3038 RED 4 — the boolean is the partition check; discarding it reported success. */
  test("markRead cannot mark another domain's message read, and says so", async () => {
    const f = fixture();
    const id = await send(f, { sender: "w", recipient: "orchestrator", cwd: f.alpha });
    await expect(invoke(f.map, "markRead")({ id, cwd: f.beta }, CTX)).rejects.toThrow(/not found/);
    expect(await read(f, { recipient: "orchestrator", unreadOnly: true, cwd: f.alpha })).toHaveLength(1);
  });

  test("markRead in the owning partition succeeds, and is idempotent", async () => {
    const f = fixture();
    const id = await send(f, { sender: "w", recipient: "orchestrator", cwd: f.alpha });
    await invoke(f.map, "markRead")({ id, cwd: f.alpha }, CTX);
    expect(await read(f, { recipient: "orchestrator", unreadOnly: true, cwd: f.alpha })).toHaveLength(0);
    // Re-marking an already-read message must NOT be mistaken for a partition miss.
    await expect(invoke(f.map, "markRead")({ id, cwd: f.alpha }, CTX)).resolves.toEqual({});
  });

  /**
   * #3038 review finding #6, against a real `StateDb`. `remote` is bound to a host, so
   * its `path` names a directory on that machine, never one here — a message addressed
   * to it must not land in the LOCAL `mail` table where nobody on `boxen0010` reads it.
   */
  test("mail to a host-bound domain fails closed instead of landing in the local partition", async () => {
    const f = fixture();
    f.db.createDomain("remote", "/home/other/phoenix", "boxen0010");
    await expect(send(f, { sender: "w", recipient: "orch@remote", cwd: f.alpha })).rejects.toThrow(/host-bound/);
    await expect(invoke(f.map, "readMail")({ recipient: "boss", cwd: f.alpha, domain: "remote" }, CTX)).rejects.toThrow(
      /host-bound/,
    );
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

  /**
   * #3038 RED 3 — end to end, because the pure-function test cannot show the payload.
   * `evil@beta@alpha` from alpha passed the spoof guard (suffix IS alpha), stored as a
   * bare-looking `evil@beta`, and the victim's reply carried the body out to beta.
   */
  test("a sender cannot smuggle a second address in its local part", async () => {
    const f = fixture();
    await expect(
      invoke(f.map, "sendMail")({ sender: "evil@beta@alpha", recipient: "orchestrator", cwd: f.alpha }, CTX),
    ).rejects.toThrow(/local part/);
    // Nothing was written anywhere.
    expect(await read(f, { cwd: f.alpha })).toHaveLength(0);
    expect(await read(f, { cwd: f.beta })).toHaveLength(0);
  });

  /**
   * #3038 RED 1, in the exact shape that shipped: a `mcx scope` sidecar becomes a domain
   * row at daemon boot with no user action, and the caller is nowhere near it. This is
   * the box this sprint runs on.
   */
  test("an unrelated auto-imported domain does not strand existing mail", async () => {
    const f = fixture({ domains: false });
    // Mail written before any domain existed — i.e. the entire history on a real install.
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "pre-existing", cwd: f.nowhere });

    // A domain appears on boot, covering a directory the caller is not in.
    f.db.createDomain("gerald", f.alpha);

    // The mail is still readable, and still writable, from where it always was.
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject)).toEqual(["pre-existing"]);
    await send(f, { sender: "orchestrator", recipient: "boss", subject: "still works", cwd: f.nowhere });
    // Sorted, not in insertion order: `created_at` is second-granularity, so two sends
    // inside the same second tie and the DESC ordering between them is unspecified.
    // Pinning the order here would be a flake waiting for a slow CI runner.
    expect((await read(f, { recipient: "boss", cwd: f.nowhere })).map((m) => m.subject).sort()).toEqual([
      "pre-existing",
      "still works",
    ]);
  });
});
