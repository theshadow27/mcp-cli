import { describe, expect, test } from "bun:test";
import type { IpcMethod, MailMessage } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { MailHandlers } from "./mail";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

// Minimal in-memory mail store
function makeMailDb() {
  let nextId = 1;
  const messages = new Map<number, MailMessage>();

  return {
    insertMail(sender: string, recipient: string, subject?: string, body?: string, replyTo?: number): number {
      const id = nextId++;
      messages.set(id, {
        id,
        sender,
        recipient,
        subject: subject ?? null,
        body: body ?? null,
        replyTo: replyTo ?? null,
        read: false,
        createdAt: new Date().toISOString(),
      } as unknown as MailMessage);
      return id;
    },
    readMail(recipient?: string, unreadOnly?: boolean, limit?: number): MailMessage[] {
      let list = [...messages.values()];
      if (recipient) list = list.filter((m) => m.recipient === recipient);
      if (unreadOnly) list = list.filter((m) => !m.read);
      if (limit !== undefined) list = list.slice(0, limit);
      return list;
    },
    getNextUnread(recipient?: string): MailMessage | undefined {
      for (const m of messages.values()) {
        if (!m.read && (!recipient || m.recipient === recipient)) return m;
      }
      return undefined;
    },
    markMailRead(id: number): void {
      const m = messages.get(id);
      if (m) (m as unknown as Record<string, unknown>).read = true;
    },
    getMailById(id: number): MailMessage | undefined {
      return messages.get(id);
    },
  };
}

function buildHandlers(
  overrides: Partial<ReturnType<typeof makeMailDb>> = {},
  isDraining = () => false,
): Map<IpcMethod, RequestHandler> {
  const db = { ...makeMailDb(), ...overrides } as never;
  const map = new Map<IpcMethod, RequestHandler>();
  new MailHandlers(db, null, isDraining).register(map);
  return map;
}

describe("MailHandlers", () => {
  describe("sendMail", () => {
    test("inserts mail and returns id", async () => {
      const map = buildHandlers();
      const result = (await invoke(map, "sendMail")(
        { sender: "alice", recipient: "bob", subject: "hi", body: "hello" },
        {} as never,
      )) as { id: number };
      expect(result.id).toBe(1);
    });

    test("second send gets incremented id", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      const r2 = (await invoke(map, "sendMail")({ sender: "a", recipient: "c" }, ctx)) as { id: number };
      expect(r2.id).toBe(2);
    });
  });

  describe("readMail", () => {
    test("returns all messages when no filter", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      await invoke(map, "sendMail")({ sender: "a", recipient: "c" }, ctx);
      const result = (await invoke(map, "readMail")(undefined, ctx)) as { messages: MailMessage[] };
      expect(result.messages.length).toBe(2);
    });

    test("filters by recipient", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "bob" }, ctx);
      await invoke(map, "sendMail")({ sender: "a", recipient: "carol" }, ctx);
      const result = (await invoke(map, "readMail")({ recipient: "bob" }, ctx)) as { messages: MailMessage[] };
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].recipient).toBe("bob");
    });

    test("filters unread only", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      await invoke(map, "markRead")({ id: 1 }, ctx);
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      const result = (await invoke(map, "readMail")({ unreadOnly: true }, ctx)) as { messages: MailMessage[] };
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].id).toBe(2);
    });
  });

  describe("waitForMail", () => {
    test("returns message immediately when one is available", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b", body: "urgent" }, ctx);
      const result = (await invoke(map, "waitForMail")({ recipient: "b", timeout: 5 }, ctx)) as {
        message: MailMessage | null;
      };
      expect(result.message).not.toBeNull();
      expect((result.message as MailMessage).recipient).toBe("b");
    });

    test("marks message as read after returning it", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      await invoke(map, "waitForMail")({ recipient: "b", timeout: 5 }, ctx);
      // Second call should find no unread messages
      const result = (await invoke(map, "waitForMail")({ recipient: "b", timeout: 1 }, ctx)) as {
        message: MailMessage | null;
      };
      expect(result.message).toBeNull();
    });

    test("returns null when no message arrives within timeout", async () => {
      const map = buildHandlers();
      const result = (await invoke(map, "waitForMail")({ recipient: "nobody", timeout: 1 }, {} as never)) as {
        message: MailMessage | null;
      };
      expect(result.message).toBeNull();
    });

    test("returns null immediately when draining", async () => {
      const map = buildHandlers({}, () => true);
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      const result = (await invoke(map, "waitForMail")({ recipient: "b", timeout: 30 }, ctx)) as {
        message: MailMessage | null;
      };
      expect(result.message).toBeNull();
    });
  });

  describe("replyToMail", () => {
    test("sends reply to original sender with Re: subject", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "alice", recipient: "bob", subject: "hello" }, ctx);
      const result = (await invoke(map, "replyToMail")({ id: 1, sender: "bob", body: "hi back" }, ctx)) as {
        id: number;
      };
      expect(result.id).toBe(2);
    });

    test("uses explicit subject when provided", async () => {
      const mailDb = makeMailDb();
      const map = new Map<IpcMethod, RequestHandler>();
      new MailHandlers(mailDb as never, null, () => false).register(map);
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "alice", recipient: "bob", subject: "topic" }, ctx);
      await invoke(map, "replyToMail")({ id: 1, sender: "bob", body: "reply", subject: "custom subject" }, ctx);
      const msgs = mailDb.readMail("alice", false);
      expect(msgs[0].subject).toBe("custom subject");
    });

    test("throws INVALID_PARAMS when original message not found", async () => {
      const map = buildHandlers();
      await expect(
        invoke(map, "replyToMail")({ id: 99, sender: "bob", body: "reply" }, {} as never),
      ).rejects.toMatchObject({ message: "Mail message 99 not found" });
    });
  });

  describe("markRead", () => {
    test("marks message read", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      await invoke(map, "markRead")({ id: 1 }, ctx);
      const result = (await invoke(map, "readMail")({ unreadOnly: true }, ctx)) as { messages: MailMessage[] };
      expect(result.messages.length).toBe(0);
    });

    test("returns empty object", async () => {
      const map = buildHandlers();
      const ctx = {} as never;
      await invoke(map, "sendMail")({ sender: "a", recipient: "b" }, ctx);
      const result = await invoke(map, "markRead")({ id: 1 }, ctx);
      expect(result).toEqual({});
    });
  });
});
