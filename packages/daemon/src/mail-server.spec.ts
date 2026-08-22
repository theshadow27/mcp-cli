import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAIL_SENT, MAIL_SERVER_NAME, type MonitorEvent } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { EventBus } from "./event-bus";
import { MailServer, buildMailToolCache } from "./mail-server";

/**
 * Every `_mail_*` tool is domain-scoped (#3038); the caller must say where it is.
 * No domains are registered in these fixtures, so this resolves to the unassigned
 * partition — the behaviour these tests asserted before the partition existed.
 */
const TOOL_CWD = "/tmp/mail-server-spec";

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
      arguments: { sender: "alice", recipient: "bob", subject: "hello", body: "hi there", cwd: TOOL_CWD },
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
      arguments: { sender: "alice", recipient: "bob", body: "msg1", cwd: TOOL_CWD },
    });
    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "alice", recipient: "bob", body: "msg2", cwd: TOOL_CWD },
    });

    const result = await client.callTool({
      name: "_mail_read",
      arguments: { recipient: "bob", cwd: TOOL_CWD },
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
      arguments: { sender: "alice", recipient: "bob", body: "waiting message", cwd: TOOL_CWD },
    });

    const result = await client.callTool({
      name: "_mail_wait",
      arguments: { recipient: "bob", timeout: 5, cwd: TOOL_CWD },
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
      arguments: { recipient: "nobody", timeout: 0.5, cwd: TOOL_CWD },
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
      arguments: { sender: "alice", recipient: "bob", subject: "hello", body: "original", cwd: TOOL_CWD },
    });
    const sendContent = sendResult.content as Array<{ type: string; text: string }>;
    const { id } = JSON.parse(sendContent[0].text) as { id: number };

    const replyResult = await client.callTool({
      name: "_mail_reply",
      arguments: { id, sender: "bob", body: "reply body", cwd: TOOL_CWD },
    });

    const replyContent = replyResult.content as Array<{ type: string; text: string }>;
    expect(replyResult.isError).toBeFalsy();
    const { id: replyId } = JSON.parse(replyContent[0].text) as { id: number };
    expect(replyId).toBeGreaterThan(id);

    // Verify reply is in alice's mailbox
    const readResult = await client.callTool({
      name: "_mail_read",
      arguments: { recipient: "alice", cwd: TOOL_CWD },
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
      arguments: { id: 9999, sender: "bob", body: "reply", cwd: TOOL_CWD },
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
      arguments: { sender: "", recipient: "bob", cwd: TOOL_CWD },
    });

    expect(result.isError).toBe(true);
  });

  // #3038. Agents reach mail through these tools, not through the CLI, so the partition
  // has to hold here too — a guard on the IPC handlers alone would be a guard at four of
  // five call sites. Each of these fails against the pre-#3038 tools.
  test("every _mail_* tool refuses an unscoped call rather than guessing a partition", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);
    const { client } = await server.start();

    for (const [name, args] of [
      ["_mail_send", { sender: "a", recipient: "b" }],
      ["_mail_read", {}],
      ["_mail_wait", { recipient: "b", timeout: 1 }],
      ["_mail_reply", { id: 1, sender: "b", body: "r" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("domain scope");
    }
  });

  test("_mail_read and _mail_wait never see another domain's mail", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    const alphaDir = join(opts.MCP_CLI_DIR, "alpha");
    const betaDir = join(opts.MCP_CLI_DIR, "beta");
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });
    db.createDomain("alpha", alphaDir);
    db.createDomain("beta", betaDir);
    server = new MailServer(db);
    const { client } = await server.start();

    await client.callTool({
      name: "_mail_send",
      arguments: { sender: "worker", recipient: "orchestrator", body: "beta only", cwd: betaDir },
    });

    const read = await client.callTool({
      name: "_mail_read",
      arguments: { recipient: "orchestrator", cwd: alphaDir },
    });
    const readContent = read.content as Array<{ type: string; text: string }>;
    expect((JSON.parse(readContent[0].text) as { messages: unknown[] }).messages).toHaveLength(0);

    const wait = await client.callTool({
      name: "_mail_wait",
      arguments: { recipient: "orchestrator", timeout: 0.5, cwd: alphaDir },
    });
    const waitContent = wait.content as Array<{ type: string; text: string }>;
    expect((JSON.parse(waitContent[0].text) as { message: unknown }).message).toBeNull();
  });

  test("_mail_send to an unknown domain errors at send time", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MailServer(db);
    const { client } = await server.start();

    const result = await client.callTool({
      name: "_mail_send",
      arguments: { sender: "a", recipient: "orchestrator@nosuchdomain", cwd: TOOL_CWD },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("unknown domain");
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
      arguments: { sender: "alice", recipient: "bob", body: "hello", cwd: TOOL_CWD },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_SENT);
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
      arguments: { sender: "alice", recipient: "bob", subject: "hi", body: "original", cwd: TOOL_CWD },
    });
    const sendContent = sendResult.content as Array<{ type: string; text: string }>;
    const { id } = JSON.parse(sendContent[0].text) as { id: number };

    events.length = 0; // reset after send

    await client.callTool({
      name: "_mail_reply",
      arguments: { id, sender: "bob", body: "reply", cwd: TOOL_CWD },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_SENT);
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
      arguments: { sender: "alice", recipient: "bob", body: "hello", cwd: TOOL_CWD },
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
      arguments: { sender: "alice", recipient: "carol", body: "hi", cwd: TOOL_CWD },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(MAIL_SENT);
  });
});
