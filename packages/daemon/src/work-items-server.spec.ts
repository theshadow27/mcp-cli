import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { WORK_ITEMS_SERVER_NAME } from "@mcp-cli/core";
import { WorkItemDb } from "./db/work-items";
import { WorkItemsServer, buildWorkItemsToolCache } from "./work-items-server";

function createWorkItemDb(): { db: WorkItemDb; raw: Database } {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA journal_mode = WAL");
  const db = new WorkItemDb(raw);
  return { db, raw };
}

describe("WORK_ITEMS_SERVER_NAME", () => {
  test("is _work_items", () => {
    expect(WORK_ITEMS_SERVER_NAME).toBe("_work_items");
  });
});

describe("buildWorkItemsToolCache", () => {
  test("returns all 5 tools", () => {
    const cache = buildWorkItemsToolCache();
    expect(cache.size).toBe(5);
    expect(cache.has("work_items_track")).toBe(true);
    expect(cache.has("work_items_untrack")).toBe(true);
    expect(cache.has("work_items_list")).toBe(true);
    expect(cache.has("work_items_get")).toBe(true);
    expect(cache.has("work_items_update")).toBe(true);
  });

  test("each tool has correct server name", () => {
    const cache = buildWorkItemsToolCache();
    for (const tool of cache.values()) {
      expect(tool.server).toBe("_work_items");
    }
  });
});

describe("WorkItemsServer", () => {
  let server: WorkItemsServer | undefined;
  let rawDb: Database | undefined;

  afterEach(async () => {
    await server?.stop();
    rawDb?.close();
    server = undefined;
    rawDb = undefined;
  });

  test("start() connects and listTools returns 5 tools", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("work_items_track");
    expect(names).toContain("work_items_untrack");
    expect(names).toContain("work_items_list");
    expect(names).toContain("work_items_get");
    expect(names).toContain("work_items_update");
  });

  test("work_items_track creates a new item by PR number", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 1135 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("pr:1135");
    expect(item.prNumber).toBe(1135);
    expect(item.phase).toBe("impl");
  });

  test("work_items_track creates a new item by issue number", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { issueNumber: 42 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("issue:42");
    expect(item.issueNumber).toBe(42);
  });

  test("work_items_track creates a new item by branch", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { branch: "feat/my-feature" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("branch:feat/my-feature");
    expect(item.branch).toBe("feat/my-feature");
  });

  test("work_items_track updates existing item if PR already tracked", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    // Create initial item
    await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 1135 },
    });

    // Track again with additional info — should update, not create
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 1135, branch: "feat/new-branch", phase: "review" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("pr:1135");
    expect(item.branch).toBe("feat/new-branch");
    expect(item.phase).toBe("review");
  });

  test("work_items_track returns error when no identifiers provided", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_track",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("At least one of");
  });

  test("work_items_untrack removes an item", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    // Create and then untrack
    await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 100 },
    });

    const result = await client.callTool({
      name: "work_items_untrack",
      arguments: { id: "pr:100" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.deleted).toBe("pr:100");

    // Verify it's gone
    const getResult = await client.callTool({
      name: "work_items_get",
      arguments: { id: "pr:100" },
    });
    expect(getResult.isError).toBe(true);
  });

  test("work_items_list returns all items", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 1 } });
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 2, phase: "review" } });
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 3 } });

    const result = await client.callTool({
      name: "work_items_list",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.count).toBe(3);
    expect(parsed.items).toHaveLength(3);
  });

  test("work_items_list filters by phase", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 1 } });
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 2, phase: "review" } });

    const result = await client.callTool({
      name: "work_items_list",
      arguments: { phase: "review" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.items[0].prNumber).toBe(2);
  });

  test("work_items_get retrieves by id", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_get",
      arguments: { id: "pr:42" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.prNumber).toBe(42);
  });

  test("work_items_get retrieves by PR number", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_get",
      arguments: { prNumber: 42 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("pr:42");
  });

  test("work_items_get retrieves by issue number", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 99 } });

    const result = await client.callTool({
      name: "work_items_get",
      arguments: { issueNumber: 99 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.id).toBe("issue:99");
  });

  test("work_items_get returns error when item not found", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_get",
      arguments: { id: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("not found");
  });

  test("work_items_get returns error when no lookup key provided", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_get",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("At least one of");
  });

  test("work_items_update modifies fields", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 50 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: {
        id: "pr:50",
        phase: "review",
        ciStatus: "passed",
        reviewStatus: "approved",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.phase).toBe("review");
    expect(item.ciStatus).toBe("passed");
    expect(item.reviewStatus).toBe("approved");
  });

  test("work_items_update returns error for nonexistent item", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "nonexistent", phase: "done" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("not found");
  });

  test("unknown tool returns error", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({ name: "work_items_unknown", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown tool");
  });

  test("work_items_track deduplicates by branch (branch → PR workflow)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    // Step 1: track by branch first
    await client.callTool({
      name: "work_items_track",
      arguments: { branch: "feat/my-feature", issueNumber: 42 },
    });

    // Step 2: track by PR + branch — should find existing by branch, not create duplicate
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 100, branch: "feat/my-feature" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    // Should have merged onto the existing record
    expect(item.branch).toBe("feat/my-feature");
    expect(item.prNumber).toBe(100);
    expect(item.issueNumber).toBe(42);

    // Verify only one item exists
    const listResult = await client.callTool({ name: "work_items_list", arguments: {} });
    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(listContent[0].text);
    expect(parsed.count).toBe(1);
  });

  test("work_items_untrack returns error for nonexistent ID", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_untrack",
      arguments: { id: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("not found");
  });

  test("work_items_update rejects invalid phase transition", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 50, phase: "done" } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:50", phase: "impl" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Invalid phase transition");
  });

  test("work_items_update allows valid phase transition", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { prNumber: 50 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:50", phase: "review" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.phase).toBe("review");
  });

  test("work_items_track rejects NaN numeric input", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: "abc" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Expected integer");
  });

  test("start() throws if called twice", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    await server.start();
    await expect(server.start()).rejects.toThrow("already started");
  });
});
