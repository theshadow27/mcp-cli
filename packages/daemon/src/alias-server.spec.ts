import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { ALIAS_SERVER_NAME, AliasServer, buildAliasToolCache } from "./alias-server";
import { StateDb } from "./db/state";
import { ServerPool } from "./server-pool";
import { makeConfig, makeMockTransport } from "./test-helpers";

function makeMockClient() {
  return {
    callTool: mock(() => Promise.resolve({ content: [{ text: "ok" }] })),
    close: mock(() => Promise.resolve()),
    listTools: mock(() => Promise.resolve({ tools: [] })),
    connect: mock(() => Promise.resolve()),
  };
}

// -- registerVirtualServer --

describe("ServerPool.registerVirtualServer", () => {
  test("virtual server appears in listServers with transport 'virtual'", () => {
    const pool = new ServerPool(makeConfig({}));
    pool.registerVirtualServer("_test", makeMockClient() as never, makeMockTransport() as never);

    const servers = pool.listServers();
    const virtual = servers.find((s) => s.name === "_test");

    expect(virtual).toBeDefined();
    expect(virtual?.transport).toBe("virtual");
    expect(virtual?.state).toBe("connected");
    expect(virtual?.source).toBe("built-in");
  });

  test("virtual server with pre-populated tools reports toolCount", () => {
    const pool = new ServerPool(makeConfig({}));
    const tools = new Map([
      ["my-tool", { name: "my-tool", server: "_test", description: "test tool", inputSchema: {} }],
    ]);
    pool.registerVirtualServer("_test", makeMockClient() as never, makeMockTransport() as never, tools);

    const servers = pool.listServers();
    const virtual = servers.find((s) => s.name === "_test");
    expect(virtual?.toolCount).toBe(1);
  });

  test("virtual server survives updateConfig that removes all config servers", () => {
    const pool = new ServerPool(makeConfig({ real: { command: "echo" } }));
    pool.registerVirtualServer("_test", makeMockClient() as never, makeMockTransport() as never);

    // Remove all config servers
    const updated = makeConfig({});
    const result = pool.updateConfig(updated);

    expect(result.removed).toEqual(["real"]);
    // Virtual server still present
    const servers = pool.listServers();
    expect(servers.find((s) => s.name === "_test")).toBeDefined();
  });

  test("virtual server is not listed in updateConfig added/removed/changed", () => {
    const pool = new ServerPool(makeConfig({}));
    pool.registerVirtualServer("_test", makeMockClient() as never, makeMockTransport() as never);

    const result = pool.updateConfig(makeConfig({ new: { command: "cat" } }));

    expect(result.added).toEqual(["new"]);
    expect(result.removed).not.toContain("_test");
    expect(result.changed).not.toContain("_test");
  });
});

// -- ALIAS_SERVER_NAME --

describe("ALIAS_SERVER_NAME", () => {
  test("is _aliases", () => {
    expect(ALIAS_SERVER_NAME).toBe("_aliases");
  });
});

// -- buildAliasToolCache --

describe("buildAliasToolCache", () => {
  test("returns tools only for defineAlias aliases", () => {
    const db = {
      listAliases: () => [
        {
          name: "structured",
          description: "A structured alias",
          filePath: "/tmp/structured.ts",
          updatedAt: Date.now(),
          aliasType: "defineAlias" as const,
          inputSchemaJson: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "freeform",
          description: "A freeform alias",
          filePath: "/tmp/freeform.ts",
          updatedAt: Date.now(),
          aliasType: "freeform" as const,
        },
      ],
    };

    const tools = buildAliasToolCache(db as never);

    expect(tools.size).toBe(1);
    expect(tools.has("structured")).toBe(true);
    expect(tools.has("freeform")).toBe(false);
  });

  test("maps alias fields to ToolInfo correctly", () => {
    const inputSchema = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    };
    const db = {
      listAliases: () => [
        {
          name: "greet",
          description: "Greet someone",
          filePath: "/tmp/greet.ts",
          updatedAt: Date.now(),
          aliasType: "defineAlias" as const,
          inputSchemaJson: inputSchema,
        },
      ],
    };

    const tools = buildAliasToolCache(db as never);
    const tool = tools.get("greet");
    expect(tool).toBeDefined();

    expect(tool?.name).toBe("greet");
    expect(tool?.server).toBe("_aliases");
    expect(tool?.description).toBe("Greet someone");
    expect(tool?.inputSchema).toEqual(inputSchema);
    expect(tool?.signature).toBeDefined();
  });

  test("provides default inputSchema when none stored", () => {
    const db = {
      listAliases: () => [
        {
          name: "minimal",
          description: "",
          filePath: "/tmp/minimal.ts",
          updatedAt: Date.now(),
          aliasType: "defineAlias" as const,
        },
      ],
    };

    const tools = buildAliasToolCache(db as never);
    const tool = tools.get("minimal");
    expect(tool).toBeDefined();

    expect(tool?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("returns empty map when no aliases exist", () => {
    const db = { listAliases: () => [] };
    const tools = buildAliasToolCache(db as never);
    expect(tools.size).toBe(0);
  });
});

// -- AliasServer integration (real Worker + MCP handshake) --

describe("AliasServer", () => {
  let server: AliasServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  function setupAlias(opts: ReturnType<typeof testOptions>) {
    db = new StateDb(opts.DB_PATH);
    mkdirSync(opts.ALIASES_DIR, { recursive: true });
    const scriptPath = join(opts.ALIASES_DIR, "greet.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "greet",',
        '  description: "Greet someone",',
        "  input: z.object({ name: z.string() }),",
        "  output: z.object({ message: z.string() }),",
        "  fn: (input) => ({ message: `Hello, ${input.name}!` }),",
        "});",
      ].join("\n"),
    );
    db.saveAlias(
      "greet",
      scriptPath,
      "Greet someone",
      "defineAlias",
      JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      JSON.stringify({ type: "object", properties: { message: { type: "string" } } }),
    );
    return { db, scriptPath };
  }

  test("start() connects and listTools returns alias tools", async () => {
    using opts = testOptions();
    const { db: testDb } = setupAlias(opts);
    server = new AliasServer(testDb);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
    expect(tools[0].description).toBe("Greet someone");
  });

  test("callTool executes alias and returns result", async () => {
    using opts = testOptions();
    const { db: testDb } = setupAlias(opts);
    server = new AliasServer(testDb);

    const { client } = await server.start();
    const result = await client.callTool({ name: "greet", arguments: { name: "World" } });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual({ message: "Hello, World!" });
  });

  test("callTool returns error for unknown alias", async () => {
    using opts = testOptions();
    const { db: testDb } = setupAlias(opts);
    server = new AliasServer(testDb);

    const { client } = await server.start();
    const result = await client.callTool({ name: "nonexistent", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(result.isError).toBe(true);
    expect(content[0].text).toContain("not found");
  });

  test("start() with no aliases returns empty tool list", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AliasServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(0);
  });

  test("refresh() updates tool list after alias save", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AliasServer(db);

    const { client } = await server.start();

    // Initially empty
    const before = await client.listTools();
    expect(before.tools).toHaveLength(0);

    // Save a new alias
    mkdirSync(opts.ALIASES_DIR, { recursive: true });
    const scriptPath = join(opts.ALIASES_DIR, "echo.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "echo",',
        '  description: "Echo input",',
        "  input: z.object({ text: z.string() }),",
        "  fn: (input) => input.text,",
        "});",
      ].join("\n"),
    );
    db.saveAlias(
      "echo",
      scriptPath,
      "Echo input",
      "defineAlias",
      JSON.stringify({ type: "object", properties: { text: { type: "string" } } }),
    );

    await server.refresh();

    // Give the worker a moment to process the refresh
    await Bun.sleep(50);

    const after = await client.listTools();
    expect(after.tools).toHaveLength(1);
    expect(after.tools[0].name).toBe("echo");
  });
});
