import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOCK_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { MockServer, buildMockToolCache, isWorkerEvent } from "./mock-server";

setDefaultTimeout(10_000);

// ── isWorkerEvent ──

describe("isWorkerEvent (mock)", () => {
  test("matches all known DB event types", () => {
    expect(isWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isWorkerEvent({ type: "db:state", sessionId: "s1", state: "active" })).toBe(true);
    expect(isWorkerEvent({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 0 })).toBe(true);
    expect(isWorkerEvent({ type: "db:disconnected", sessionId: "s1", reason: "x" })).toBe(true);
    expect(isWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);
  });

  test("matches ready event type", () => {
    expect(isWorkerEvent({ type: "ready" })).toBe(true);
  });

  test("rejects JSON-RPC messages", () => {
    expect(isWorkerEvent({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
  });

  test("rejects messages with unknown type values", () => {
    expect(isWorkerEvent({ type: "unknown" })).toBe(false);
    expect(isWorkerEvent({ type: "" })).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(isWorkerEvent(null)).toBe(false);
    expect(isWorkerEvent(undefined)).toBe(false);
    expect(isWorkerEvent("string")).toBe(false);
    expect(isWorkerEvent(42)).toBe(false);
  });

  test("rejects objects without type field", () => {
    expect(isWorkerEvent({})).toBe(false);
    expect(isWorkerEvent({ data: "foo" })).toBe(false);
  });
});

// ── buildMockToolCache ──

describe("buildMockToolCache", () => {
  test("returns all 9 mock tools", () => {
    const tools = buildMockToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("mock_prompt")).toBe(true);
    expect(tools.has("mock_session_list")).toBe(true);
    expect(tools.has("mock_session_status")).toBe(true);
    expect(tools.has("mock_interrupt")).toBe(true);
    expect(tools.has("mock_bye")).toBe(true);
    expect(tools.has("mock_transcript")).toBe(true);
    expect(tools.has("mock_wait")).toBe(true);
    expect(tools.has("mock_approve")).toBe(true);
    expect(tools.has("mock_deny")).toBe(true);
  });

  test("all tools have server set to _mock", () => {
    const tools = buildMockToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(MOCK_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildMockToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── MOCK_SERVER_NAME ──

describe("MOCK_SERVER_NAME", () => {
  test("is _mock", () => {
    expect(MOCK_SERVER_NAME).toBe("_mock");
  });
});

// ── MockServer integration (real Worker + MCP handshake) ──

describe("MockServer", () => {
  let server: MockServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  // ── Shared server for read-only integration tests ──
  describe("read-only (shared worker)", () => {
    let sharedServer: MockServer;
    let sharedDb: StateDb;
    let sharedClient: Awaited<ReturnType<MockServer["start"]>>["client"];
    let sharedOpts: ReturnType<typeof testOptions>;
    let initialized = false;

    async function ensureServer(): Promise<void> {
      if (!initialized) {
        sharedOpts = testOptions();
        sharedDb = new StateDb(sharedOpts.DB_PATH);
        sharedServer = new MockServer(sharedDb, undefined, undefined, silentLogger);
        const { client: c } = await sharedServer.start();
        sharedClient = c;
        initialized = true;
      }
    }

    beforeEach(() => {
      server = undefined;
      db = undefined;
    });

    afterAll(async () => {
      await sharedServer?.stop();
      sharedDb?.close();
      sharedOpts?.[Symbol.dispose]();
    });

    test("start() connects and listTools returns mock tools", async () => {
      await ensureServer();
      const { tools } = await sharedClient.listTools();

      expect(tools.length).toBe(9);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "mock_approve",
        "mock_bye",
        "mock_deny",
        "mock_interrupt",
        "mock_prompt",
        "mock_session_list",
        "mock_session_status",
        "mock_transcript",
        "mock_wait",
      ]);
    });

    test("mock_session_list returns empty array initially", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({ name: "mock_session_list", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0].text);

      expect(sessions).toEqual([]);
    });

    test("mock_session_status returns error for unknown session", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({
        name: "mock_session_status",
        arguments: { sessionId: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Unknown session");
    });
  });

  // handleWorkerEvent tests
  test("worker db:upsert event persists session to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "s1", state: "active", model: "mock", cwd: "/tmp" },
    });

    const row = db.getSession("s1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
    expect(row?.model).toBe("mock");
  });

  test("worker db:state event updates session state", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "s2", state: "active" });

    const row = db.getSession("s2");
    expect(row?.state).toBe("active");
  });

  test("worker db:end event marks session as ended", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s4", state: "active" } });
    handle({ type: "db:end", sessionId: "s4" });

    const row = db.getSession("s4");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  test("hasActiveSessions() returns false initially", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-stop", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();
    expect(server.hasActiveSessions()).toBe(false);
    server = undefined;
  });

  test("stop() ends sessions in DB", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stop-end-1", state: "active" } });

    await server.stop();

    const row1 = db.getSession("stop-end-1");
    expect(row1?.state).toBe("ended");
    expect(row1?.endedAt).not.toBeNull();

    server = undefined;
  });

  test("start() throws if called while worker is already running", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    await server.start();

    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  test("onActivity is called on db:upsert, db:state, and db:cost events", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    let activityCount = 0;
    server.onActivity = () => {
      activityCount++;
    };

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s1", state: "active" } });
    expect(activityCount).toBe(1);

    handle({ type: "db:state", sessionId: "s1", state: "idle" });
    expect(activityCount).toBe(2);

    handle({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 5 });
    expect(activityCount).toBe(3);

    // db:end and db:disconnected should NOT trigger onActivity
    handle({ type: "db:disconnected", sessionId: "s1", reason: "test" });
    expect(activityCount).toBe(3);

    handle({ type: "db:end", sessionId: "s1" });
    expect(activityCount).toBe(3);
  });

  // ── Session TTL pruning ──

  test("pruneDeadSessions prunes sessions after TTL expires", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stale-1", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    // Not yet expired
    server.pruneDeadSessions(Date.now());
    expect(server.hasActiveSessions()).toBe(true);

    // Simulate time past TTL (10+ minutes)
    const future = Date.now() + 11 * 60 * 1000;
    server.pruneDeadSessions(future);

    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("stale-1");
    expect(row?.state).toBe("ended");
  });
});

// ── Extended mock-script DSL integration tests ──

const POLL_INTERVAL_MS = 50;

describe("Mock script DSL (extended entries)", () => {
  let server: MockServer | undefined;
  let db: StateDb | undefined;
  let client: Awaited<ReturnType<MockServer["start"]>>["client"];
  let opts: ReturnType<typeof testOptions>;
  let scriptDir: string;

  async function setup(): Promise<void> {
    opts = testOptions();
    scriptDir = join(opts.dir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);
    const { client: c } = await server.start();
    client = c;
  }

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
    opts?.[Symbol.dispose]();
  });

  function writeScript(name: string, entries: unknown[]): string {
    const path = join(scriptDir, name);
    writeFileSync(path, JSON.stringify(entries));
    return path;
  }

  async function runScript(path: string): Promise<string> {
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: true } });
    const content = result.content as Array<{ type: string; text: string }>;
    return content[0].text;
  }

  test("legacy format still works", async () => {
    await setup();
    const path = writeScript("legacy.json", [
      { delay: 0, text: "Hello" },
      { delay: 0, text: "World" },
    ]);
    const text = await runScript(path);
    const parsed = JSON.parse(text);
    expect(parsed.type).toBe("session:result");
    expect(parsed.result.tokens).toBe(2);
  });

  test("emit:init sets session_id", async () => {
    await setup();
    const path = writeScript("init.json", [
      { emit: "init", session_id: "custom-id" },
      { emit: "response", text: "after init" },
    ]);
    const text = await runScript(path);
    const parsed = JSON.parse(text);
    expect(parsed.type).toBe("session:result");
  });

  test("emit:response emits session:response event", async () => {
    await setup();
    const path = writeScript("response.json", [{ emit: "response", text: "Hello from DSL" }]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const content = result.content as Array<{ type: string; text: string }>;
    const { sessionId } = JSON.parse(content[0].text);

    const waitResult = await client.callTool({ name: "mock_wait", arguments: { sessionId } });
    const waitContent = waitResult.content as Array<{ type: string; text: string }>;
    const waitParsed = JSON.parse(waitContent[0].text);
    expect(waitParsed.type).toBe("session:result");

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const transcriptContent = transcript.content as Array<{ type: string; text: string }>;
    const entries = JSON.parse(transcriptContent[0].text);
    expect(entries.some((e: { text: string }) => e.text === "Hello from DSL")).toBe(true);
  });

  test("emit:tool_call appears in transcript", async () => {
    await setup();
    const path = writeScript("tool_call.json", [{ emit: "tool_call", name: "Read", args: { path: "/tmp/foo" } }]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    expect(entries.some((e: { text: string }) => e.text?.includes("[tool_call] Read"))).toBe(true);
  });

  test("emit:cost accumulates in result", async () => {
    await setup();
    const path = writeScript("cost.json", [
      { emit: "cost", usd: 0.001, tokens_in: 100, tokens_out: 50 },
      { emit: "cost", usd: 0.002, tokens_in: 200, tokens_out: 100 },
    ]);
    const text = await runScript(path);
    const parsed = JSON.parse(text);
    expect(parsed.type).toBe("session:result");
    expect(parsed.result.cost).toBeCloseTo(0.003);
    expect(parsed.result.tokens).toBe(450);
  });

  test("emit:error terminates with session:error", async () => {
    await setup();
    const path = writeScript("error.json", [
      { emit: "response", text: "before error" },
      { emit: "error", message: "something broke" },
    ]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    expect(entries.some((e: { text: string }) => e.text?.includes("something broke"))).toBe(true);
  });

  test("emit:disconnect emits session:disconnected", async () => {
    await setup();
    const path = writeScript("disconnect.json", [{ emit: "disconnect", reason: "network failure" }]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = db?.getSession(sessionId);
      if (row?.state === "disconnected") break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(db?.getSession(sessionId)?.state).toBe("disconnected");
  });

  test("emit:end terminates the session", async () => {
    await setup();
    const path = writeScript("end.json", [{ emit: "response", text: "bye" }, { emit: "end" }]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });
    const status = db?.getSession(sessionId);
    expect(status?.state).toBe("ended");
  });

  test("emit:result with custom text", async () => {
    await setup();
    const path = writeScript("result.json", [{ emit: "result", text: "custom done message" }]);
    const text = await runScript(path);
    const parsed = JSON.parse(text);
    expect(parsed.type).toBe("session:result");
    expect(parsed.result.result).toBe("custom done message");
  });

  test("permission_request + approve round-trip", async () => {
    await setup();
    const path = writeScript("perm-approve.json", [
      { emit: "permission_request", tool: "Write", args: { path: "/tmp/x" }, request_id: "req-1" },
      { wait_for: "approve", timeout_ms: 5000 },
      { emit: "response", text: "approved and continuing" },
    ]);

    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    // Poll until permission request shows up as waiting_permission in DB
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = db?.getSession(sessionId);
      if (row?.state === "waiting_permission") break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(db?.getSession(sessionId)?.state).toBe("waiting_permission");

    // Approve the permission
    const approveResult = await client.callTool({
      name: "mock_approve",
      arguments: { sessionId, requestId: "req-1" },
    });
    expect(approveResult.isError).toBeFalsy();

    // Wait for the script to finish
    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    expect(entries.some((e: { text: string }) => e.text === "approved and continuing")).toBe(true);
  });

  test("permission_request + deny round-trip", async () => {
    await setup();
    const path = writeScript("perm-deny.json", [
      { emit: "permission_request", tool: "Bash", args: { command: "rm -rf /" }, request_id: "req-deny" },
      { wait_for: "deny", timeout_ms: 5000 },
      { emit: "response", text: "denied and continuing" },
    ]);

    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = db?.getSession(sessionId);
      if (row?.state === "waiting_permission") break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }

    const denyResult = await client.callTool({
      name: "mock_deny",
      arguments: { sessionId, requestId: "req-deny" },
    });
    expect(denyResult.isError).toBeFalsy();

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    expect(entries.some((e: { text: string }) => e.text === "denied and continuing")).toBe(true);
  });

  test("approve returns error for unknown request", async () => {
    await setup();
    const path = writeScript("perm-unknown.json", [
      { emit: "permission_request", tool: "Write", request_id: "req-x" },
      { wait_for: "approve", timeout_ms: 5000 },
    ]);

    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = db?.getSession(sessionId);
      if (row?.state === "waiting_permission") break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }

    const approveResult = await client.callTool({
      name: "mock_approve",
      arguments: { sessionId, requestId: "wrong-id" },
    });
    expect(approveResult.isError).toBe(true);
    const text = (approveResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No pending permission");
    expect(text).toContain("req-x");
  });

  test("approve resolves even if sent before wait_for executes", async () => {
    await setup();
    const path = writeScript("early-approve.json", [
      { emit: "permission_request", tool: "Write", args: { path: "/tmp/x" }, request_id: "early-1" },
      { wait_for: "approve", timeout_ms: 5000 },
      { emit: "response", text: "continued after early approve" },
    ]);

    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = db?.getSession(sessionId);
      if (row?.state === "waiting_permission") break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(db?.getSession(sessionId)?.state).toBe("waiting_permission");

    const approveResult = await client.callTool({
      name: "mock_approve",
      arguments: { sessionId, requestId: "early-1" },
    });
    expect(approveResult.isError).toBeFalsy();

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    expect(entries.some((e: { text: string }) => e.text === "continued after early approve")).toBe(true);
    expect(entries.some((e: { text: string }) => e.text === "permission approve")).toBe(true);
  });

  test("mixed legacy + emit entries in same script", async () => {
    await setup();
    const path = writeScript("mixed.json", [
      { delay: 0, text: "legacy line" },
      { emit: "response", text: "new line" },
      { emit: "cost", usd: 0.001, tokens_in: 10, tokens_out: 5 },
    ]);
    const text = await runScript(path);
    const parsed = JSON.parse(text);
    expect(parsed.type).toBe("session:result");
    expect(parsed.result.cost).toBeCloseTo(0.001);
  });

  test("delay on emit entries preserves ordering", async () => {
    await setup();
    const path = writeScript("delay.json", [
      { emit: "response", text: "first", delay: 0 },
      { emit: "response", text: "second", delay: 10 },
    ]);
    const result = await client.callTool({ name: "mock_prompt", arguments: { prompt: path, wait: false } });
    const { sessionId } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

    await client.callTool({ name: "mock_wait", arguments: { sessionId } });

    const transcript = await client.callTool({ name: "mock_transcript", arguments: { sessionId } });
    const entries = JSON.parse((transcript.content as Array<{ type: string; text: string }>)[0].text);
    const texts = entries.filter((e: { role: string }) => e.role === "assistant").map((e: { text: string }) => e.text);
    expect(texts).toEqual(["first", "second"]);
  });
});
