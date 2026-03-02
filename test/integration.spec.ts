/**
 * Integration tests exercising the echo MCP server over stdio transport.
 *
 * Verifies the full MCP protocol round-trip:
 *   config → transport → server → tool call → response
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("echo-server integration", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["test/echo-server.ts"],
      stderr: "pipe",
    });

    client = new Client({ name: "integration-test", version: "0.1.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  test("listTools returns all 3 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "echo", "fail"]);
  });

  test("echo tool returns input message", async () => {
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.isError).toBeFalsy();
  });

  test("add tool returns sum", async () => {
    const result = await client.callTool({
      name: "add",
      arguments: { a: 2, b: 3 },
    });
    expect(result.content).toEqual([{ type: "text", text: "5" }]);
    expect(result.isError).toBeFalsy();
  });

  test("fail tool returns error without crashing", async () => {
    const result = await client.callTool({ name: "fail", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("intentional failure"),
        }),
      ]),
    );
  });

  test("echo tool schemas are correct", async () => {
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo");
    expect(echo).toBeDefined();
    expect(echo?.inputSchema.required).toEqual(["message"]);
    expect(echo?.inputSchema.properties).toHaveProperty("message");
  });
});
