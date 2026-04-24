import { afterEach, describe, expect, test } from "bun:test";
import { MAIL_RECEIVED, MAIL_SERVER_NAME, type MonitorEvent } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { EventBus } from "./event-bus";
import { MailServer, buildMailToolCache } from "./mail-server";

describe("MAIL_SERVER_NAME", () => {
  test("is _mail", () => {
    expect(MAIL_SERVER_NAME).toBe("_mail");
  });
});

describe("buildMailToolCache", () => {
  test("returns all 4 tools", () => {
    const cache = buildMailToolCache();
    expect(cache.size).toBe(4);
    expect(cache.has("_mail_send")).toBe(true);
    expect(cache.has("_mail_read")).toBe(true);
    expect(cache.has("_mail_wait")).toBe(true);
    expect(cache.has("_mail_reply")).toBe(true);
  });

  test("each tool has correct server name", () => {
    const cache = buildMailToolCache();
    for (const tool of cache.values()) {
      expect(tool.server).toBe("_mail");
    }
  });
});

describe("MailServer", () => {
  let server: MailServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("start() connects and listTools returns 4 mail tools", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("_mail_send");
    expect(names).toContain("_mail_read");
    expect(names).toContain("_mail_wait");
    expect(names).toContain("_mail_reply");
  });

  test("_mail_send inserts a message and returns its id", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", subject: "hello", body: "hi there" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(content[0].text) as { id: number };
    expect(typeof parsed.id).toBe("number");
    expect(parsed.id).toBeGreaterThan(0);
  });

  test("_mail_read returns sent messages", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "msg1" },
    });
    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "msg2" },
    });

    const result = await client.callTool({
      name: "_mail_read",
      arguments: { recipient: "bob" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(content[0].text) as { messages: unknown[] };
    expect(parsed.messages).toHaveLength(2);
  });

  test("_mail_wait returns immediately if message is available", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "waiting message" },
    });

    const result = await client.callTool({
      name: "_mail_wait",
      arguments: { recipient: "bob", timeout: 5 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(content[0].text) as { message: { body: string } | null };
    expect(parsed.message).not.toBeNull();
    expect(parsed.message?.body).toBe("waiting message");
  });

  test("_mail_wait returns null on timeout when no message", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    const result = await client.callTool({
      name: "_mail_wait",
      arguments: { recipient: "nobody", timeout: 0.5 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as { message: null };
    expect(parsed.message).toBeNull();
  });

  test("_mail_reply sends a reply to original sender", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    const sendResult = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", subject: "hello", body: "original" },
    });
    const sendContent = sendResult.content as Array<{ type: string; text: string }>;
    const { id } = JSON.parse(sendContent[0].text) as { id: number };

    const replyResult = await client.callTool({
      name: "_mail_reply",
      arguments: { id, sender: "bob", body: "reply body" },
    });

    const replyContent = replyResult.content as Array<{ type: string; text: string }>;
    expect(replyResult.isError).toBeFalsy();
    const { id: replyId } = JSON.parse(replyContent[0].text) as { id: number };
    expect(replyId).toBeGreaterThan(id);

    // Verify reply is in alice's mailbox
    const readResult = await client.callTool({
      name: "_mail_read",
      arguments: { recipient: "alice" },
    });
    const readContent = readResult.content as Array<{ type: string; text: string }>;
    const { messages } = JSON.parse(readContent[0].text) as { messages: Array<{ subject: string; replyTo: number }> };
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("Re: hello");
    expect(messages[0].replyTo).toBe(id);
  });

  test("_mail_reply returns error for nonexistent message", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    const result = await client.callTool({
      name: "_mail_reply",
      arguments: { id: 9999, sender: "bob", body: "reply" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("not found");
  });

  test("_mail_send returns error when sender is missing", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    const result = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "", recipient: "bob" },
    });

    expect(result.isError).toBe(true);
  });

  test("unknown tool returns error", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const { client } = await server.start();

    const result = await client.callTool({ name: "_mail_unknown", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown tool");
  });

  test("_mail_send publishes monitor event when EventBus is set", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    const bus = new EventBus();
    server = new MailServer(db, bus);

    const events: MonitorEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const { client } = await server.start();
    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "hello" },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_RECEIVED);
    expect(events[0].sender).toBe("alice");
    expect(events[0].recipient).toBe("bob");
  });

  test("_mail_reply publishes monitor event when EventBus is set", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    const bus = new EventBus();
    server = new MailServer(db, bus);

    const events: MonitorEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const { client } = await server.start();

    const sendResult = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", subject: "hi", body: "original" },
    });
    const sendContent = sendResult.content as Array<{ type: string; text: string }>;
    const { id } = JSON.parse(sendContent[0].text) as { id: number };

    events.length = 0; // reset after send

    await client.callTool({
      name: "_mail_reply",
      arguments: { id, sender: "bob", body: "reply" },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_RECEIVED);
    expect(events[0].sender).toBe("bob");
    expect(events[0].recipient).toBe("alice");
  });

  test("_mail_send does not throw when no EventBus is set", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db); // no EventBus

    const { client } = await server.start();
    const result = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "hello" },
    });
    expect(result.isError).toBeFalsy();
  });

  test("setEventBus wires events after construction", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);

    const bus = new EventBus();
    const events: MonitorEvent[] = [];
    bus.subscribe((e) => events.push(e));
    server.setEventBus(bus);

    const { client } = await server.start();
    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "carol", body: "hi" },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_RECEIVED);
  });
});
