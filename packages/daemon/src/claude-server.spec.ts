import { afterEach, describe, expect, test } from "bun:test";
import { testOptions } from "../../../test/test-options";
import { CLAUDE_SERVER_NAME, ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { StateDb } from "./db/state";

// ── buildClaudeToolCache ──

describe("buildClaudeToolCache", () => {
  test("returns all 5 claude tools", () => {
    const tools = buildClaudeToolCache();
    expect(tools.size).toBe(5);
    expect(tools.has("claude_prompt")).toBe(true);
    expect(tools.has("claude_session_list")).toBe(true);
    expect(tools.has("claude_session_status")).toBe(true);
    expect(tools.has("claude_interrupt")).toBe(true);
    expect(tools.has("claude_transcript")).toBe(true);
  });

  test("all tools have server set to _claude", () => {
    const tools = buildClaudeToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(CLAUDE_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildClaudeToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── CLAUDE_SERVER_NAME ──

describe("CLAUDE_SERVER_NAME", () => {
  test("is _claude", () => {
    expect(CLAUDE_SERVER_NAME).toBe("_claude");
  });
});

// ── ClaudeServer integration (real Worker + MCP handshake) ──

describe("ClaudeServer", () => {
  let server: ClaudeServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("start() connects and listTools returns claude tools", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools.length).toBe(5);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claude_interrupt",
      "claude_prompt",
      "claude_session_list",
      "claude_session_status",
      "claude_transcript",
    ]);
  });

  test("start() reports a WS port", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    expect(server.port).toBeGreaterThan(0);
  });

  test("claude_session_list returns empty array initially", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    const { client } = await server.start();
    const result = await client.callTool({ name: "claude_session_list", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const sessions = JSON.parse(content[0].text);

    expect(sessions).toEqual([]);
  });

  test("claude_session_status returns error for unknown session", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "claude_session_status",
      arguments: { sessionId: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown session");
  });

  test("stop() terminates worker cleanly", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();
    await server.stop();

    expect(server.port).toBeNull();
    server = undefined; // prevent double stop
  });
});
