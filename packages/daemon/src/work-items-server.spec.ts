import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { WORK_ITEMS_SERVER_NAME } from "@mcp-cli/core";
import { WorkItemDb } from "./db/work-items";
import { type PhaseStateStore, WorkItemsServer, buildWorkItemsToolCache } from "./work-items-server";

function createWorkItemDb(): { db: WorkItemDb; raw: Database } {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA journal_mode = WAL");
  const db = new WorkItemDb(raw);
  return { db, raw };
}

function createPhaseStateStore(raw: Database): PhaseStateStore {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS alias_state (
      repo_root TEXT NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (repo_root, namespace, key)
    )
  `);
  return {
    getAliasState(repoRoot: string, namespace: string, key: string): unknown {
      const row = raw
        .query<{ value_json: string }, [string, string, string]>(
          "SELECT value_json FROM alias_state WHERE repo_root = ? AND namespace = ? AND key = ?",
        )
        .get(repoRoot, namespace, key);
      if (!row) return undefined;
      return JSON.parse(row.value_json);
    },
    setAliasState(repoRoot: string, namespace: string, key: string, value: unknown): void {
      const json = JSON.stringify(value);
      raw.run(
        `INSERT INTO alias_state (repo_root, namespace, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, unixepoch())
         ON CONFLICT(repo_root, namespace, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [repoRoot, namespace, key, json],
      );
    },
    listAliasState(repoRoot: string, namespace: string): Record<string, unknown> {
      const rows = raw
        .query<{ key: string; value_json: string }, [string, string]>(
          "SELECT key, value_json FROM alias_state WHERE repo_root = ? AND namespace = ?",
        )
        .all(repoRoot, namespace);
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        out[row.key] = JSON.parse(row.value_json);
      }
      return out;
    },
  };
}

describe("WORK_ITEMS_SERVER_NAME", () => {
  test("is _work_items", () => {
    expect(WORK_ITEMS_SERVER_NAME).toBe("_work_items");
  });
});

describe("buildWorkItemsToolCache", () => {
  test("returns all 8 tools", () => {
    const cache = buildWorkItemsToolCache();
    expect(cache.size).toBe(8);
    expect(cache.has("work_items_track")).toBe(true);
    expect(cache.has("work_items_untrack")).toBe(true);
    expect(cache.has("work_items_list")).toBe(true);
    expect(cache.has("work_items_get")).toBe(true);
    expect(cache.has("work_items_update")).toBe(true);
    expect(cache.has("phase_state_get")).toBe(true);
    expect(cache.has("phase_state_set")).toBe(true);
    expect(cache.has("phase_state_list")).toBe(true);
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

  test("start() connects and listTools returns 8 tools", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(8);
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

  test("work_items_track calls onTrack callback", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;

    let trackCallCount = 0;
    server = new WorkItemsServer(db, { onTrack: () => trackCallCount++ });

    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 99 } });
    expect(trackCallCount).toBe(1);

    // Second track call also fires
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 100 } });
    expect(trackCallCount).toBe(2);
  });

  test("start() throws if called twice", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);

    await server.start();
    await expect(server.start()).rejects.toThrow("already started");
  });

  test("work_items_update rejects unknown phase when manifest is present", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const manifest = {
      version: 1 as const,
      initial: "plan",
      phases: {
        plan: { source: "./plan.ts", next: ["build"] },
        build: { source: "./build.ts", next: [] },
      },
    };
    server = new WorkItemsServer(db, { loadManifest: () => manifest });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:42", phase: "buld", repoRoot: "/tmp/any" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toMatch(/unknown phase "buld"/);
    expect(content[0].text).toMatch(/declared phases: plan, build/);
  });

  test("work_items_update accepts manifest-declared phase outside legacy enum", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const manifest = {
      version: 1 as const,
      initial: "plan",
      phases: {
        plan: { source: "./plan.ts", next: ["ship"] },
        ship: { source: "./ship.ts", next: [] },
      },
    };
    server = new WorkItemsServer(db, { loadManifest: () => manifest });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 50 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:50", phase: "ship", repoRoot: "/tmp/any" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text).phase).toBe("ship");
  });

  test("work_items_update without manifest uses hardcoded canTransition", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db); // no loadManifest
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 60 } });

    // impl → done is allowed in the hardcoded graph
    const ok = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:60", phase: "done" },
    });
    expect(ok.isError).toBeFalsy();
  });

  test("work_items_update force=true bypasses manifest phase-name validation", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const manifest = {
      version: 1 as const,
      initial: "plan",
      phases: {
        plan: { source: "./plan.ts", next: ["ship"] },
        ship: { source: "./ship.ts", next: [] },
      },
    };
    server = new WorkItemsServer(db, { loadManifest: () => manifest });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 80 } });

    // "adhoc" is not declared in the manifest — rejected without force
    const rejected = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:80", phase: "adhoc", repoRoot: "/tmp/any" },
    });
    expect(rejected.isError).toBe(true);

    // With force=true, even an undeclared phase is accepted and the bypass is logged
    const forced = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:80", phase: "adhoc", repoRoot: "/tmp/any", force: true, forceReason: "undeclared bypass" },
    });
    expect(forced.isError).toBeFalsy();
    const log = db.listTransitions("pr:80");
    const last = log[log.length - 1];
    expect(last.toPhase).toBe("adhoc");
    expect(last.forced).toBe(true);
    expect(last.forceReason).toBe("undeclared bypass");
  });

  test("work_items_update force=true bypasses legacy transition check and logs forced", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 70 } });
    await client.callTool({ name: "work_items_update", arguments: { id: "pr:70", phase: "done" } });

    // done → impl is not allowed normally
    const rejected = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:70", phase: "impl" },
    });
    expect(rejected.isError).toBe(true);

    const forced = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:70", phase: "impl", force: true, forceReason: "test reopen" },
    });
    expect(forced.isError).toBeFalsy();
    const log = db.listTransitions("pr:70");
    const last = log[log.length - 1];
    expect(last.fromPhase).toBe("done");
    expect(last.toPhase).toBe("impl");
    expect(last.forced).toBe(true);
    expect(last.forceReason).toBe("test reopen");
  });

  test("work_items_update auto-populates branch from prNumber when item has no branch (#1424)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const calls: number[] = [];
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async (pr) => {
        calls.push(pr);
        return "feat/auto-resolved";
      },
    });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 1378 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:1378", prNumber: 1420 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.prNumber).toBe(1420);
    expect(item.branch).toBe("feat/auto-resolved");
    expect(calls).toEqual([1420]);
  });

  test("work_items_update explicit branch wins over auto-resolve", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    let resolverCalled = false;
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => {
        resolverCalled = true;
        return "auto";
      },
    });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:42", prNumber: 99, branch: "explicit/branch" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.branch).toBe("explicit/branch");
    expect(resolverCalled).toBe(false);
  });

  test("work_items_update does not auto-resolve when branch already set", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    let resolverCalled = false;
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => {
        resolverCalled = true;
        return "auto";
      },
    });
    const { client } = await server.start();
    await client.callTool({
      name: "work_items_track",
      arguments: { issueNumber: 10, branch: "existing" },
    });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:10", prNumber: 20 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.branch).toBe("existing");
    expect(resolverCalled).toBe(false);
  });

  test("work_items_update tolerates resolver failure", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => {
        throw new Error("gh not found");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 1 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:1", prNumber: 2 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.prNumber).toBe(2);
    expect(item.branch).toBeNull();
  });

  test("work_items_update does not auto-resolve when resolver returns null", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => null,
    });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 5 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:5", prNumber: 6 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.branch).toBeNull();
  });

  test("work_items_update does not clobber branch written during async resolve (TOCTOU)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => {
        // Simulate a concurrent explicit-branch write landing during the
        // gh subprocess await, then resolve with a "stale" value.
        await gate;
        return "resolved/from-gh";
      },
    });
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 77 } });

    const slowUpdate = client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:77", prNumber: 88 },
    });

    // Simulate the concurrent explicit-branch write committing directly to
    // the DB while the slow update is awaiting its resolver. The guard
    // re-reads after the await and must not overwrite this value.
    db.updateWorkItem("issue:77", { branch: "explicit/winner" });
    release();

    const result = await slowUpdate;
    expect(result.isError).toBeFalsy();
    const final = db.getWorkItem("issue:77");
    expect(final?.branch).toBe("explicit/winner");
  });

  test("work_items_update treats branch=null as absent (no 'null' string coercion)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();
    await client.callTool({
      name: "work_items_track",
      arguments: { issueNumber: 55, branch: "feat/existing" },
    });

    // Sending `branch: null` must not overwrite the existing branch with the
    // literal string "null" (round-3 Copilot inline comment).
    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "issue:55", branch: null, ciStatus: "passed" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.branch).toBe("feat/existing");
    expect(item.ciStatus).toBe("passed");
  });

  test("work_items_track auto-populates branch from prNumber (#1449)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const calls: number[] = [];
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async (pr) => {
        calls.push(pr);
        return "feat/from-track";
      },
    });
    const { client } = await server.start();

    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 1420 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.prNumber).toBe(1420);
    expect(item.branch).toBe("feat/from-track");
    expect(calls).toEqual([1420]);
  });

  test("work_items_update rejects unknown keys (#1445)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:42", qa_session_id: "abc-123", session_id: "def-456" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown keys");
    expect(content[0].text).toContain("qa_session_id");
    expect(content[0].text).toContain("session_id");
    expect(content[0].text).toContain("Phase-namespace state");
  });

  test("work_items_update rejects mix of known and unknown keys (#1445)", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: { id: "pr:42", ciStatus: "passed", model: "opus" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("model");
    // Only "model" should be listed as unknown, not "ciStatus"
    expect(content[0].text).toMatch(/^Unknown keys: model\./);
  });

  test("work_items_update accepts all known keys without error", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();
    await client.callTool({ name: "work_items_track", arguments: { prNumber: 42 } });

    const result = await client.callTool({
      name: "work_items_update",
      arguments: {
        id: "pr:42",
        phase: "review",
        ciStatus: "passed",
        reviewStatus: "approved",
        prState: "open",
        prUrl: "https://example.com",
        ciRunId: 123,
        ciSummary: "all green",
        branch: "feat/test",
        issueNumber: 99,
      },
    });

    expect(result.isError).toBeFalsy();
  });

  test("work_items_track does not auto-resolve when branch is explicitly provided", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    let resolverCalled = false;
    server = new WorkItemsServer(db, {
      resolveBranchFromPr: async () => {
        resolverCalled = true;
        return "auto";
      },
    });
    const { client } = await server.start();

    const result = await client.callTool({
      name: "work_items_track",
      arguments: { prNumber: 99, branch: "explicit/branch" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0].text);
    expect(item.branch).toBe("explicit/branch");
    expect(resolverCalled).toBe(false);
  });
});

describe("phase_state tools", () => {
  let server: WorkItemsServer | undefined;
  let rawDb: Database | undefined;

  afterEach(async () => {
    await server?.stop();
    rawDb?.close();
    server = undefined;
    rawDb = undefined;
  });

  test("phase_state_set and phase_state_get round-trip a value", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 1 } });

    const setResult = await client.callTool({
      name: "phase_state_set",
      arguments: { workItemId: "issue:1", repoRoot: "/repo", key: "session_id", value: "abc-123" },
    });
    expect(setResult.isError).toBeFalsy();
    const setBody = JSON.parse((setResult.content as Array<{ text: string }>)[0].text);
    expect(setBody.ok).toBe(true);
    expect(setBody.phase).toBe("impl");

    const getResult = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:1", repoRoot: "/repo", key: "session_id" },
    });
    expect(getResult.isError).toBeFalsy();
    const getBody = JSON.parse((getResult.content as Array<{ text: string }>)[0].text);
    expect(getBody.value).toBe("abc-123");
    expect(getBody.phase).toBe("impl");
  });

  test("phase_state_get returns undefined for missing key", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 2 } });

    const result = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:2", repoRoot: "/repo", key: "nonexistent" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.value).toBeUndefined();
  });

  test("phase_state_list returns all keys for the phase", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 3 } });

    await client.callTool({
      name: "phase_state_set",
      arguments: { workItemId: "issue:3", repoRoot: "/repo", key: "session_id", value: "s1" },
    });
    await client.callTool({
      name: "phase_state_set",
      arguments: { workItemId: "issue:3", repoRoot: "/repo", key: "worktree", value: "/tmp/wt" },
    });

    const result = await client.callTool({
      name: "phase_state_list",
      arguments: { workItemId: "issue:3", repoRoot: "/repo" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.count).toBe(2);
    expect(body.entries.session_id).toBe("s1");
    expect(body.entries.worktree).toBe("/tmp/wt");
    expect(body.phase).toBe("impl");
  });

  test("phase override reads from a different phase namespace", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 4 } });

    await client.callTool({
      name: "phase_state_set",
      arguments: { workItemId: "issue:4", repoRoot: "/repo", key: "session_id", value: "review-sess", phase: "review" },
    });

    const defaultResult = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:4", repoRoot: "/repo", key: "session_id" },
    });
    const defaultBody = JSON.parse((defaultResult.content as Array<{ text: string }>)[0].text);
    expect(defaultBody.value).toBeUndefined();

    const overrideResult = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:4", repoRoot: "/repo", key: "session_id", phase: "review" },
    });
    const overrideBody = JSON.parse((overrideResult.content as Array<{ text: string }>)[0].text);
    expect(overrideBody.value).toBe("review-sess");
    expect(overrideBody.phase).toBe("review");
  });

  test("phase_state_get errors for nonexistent work item", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    const result = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:999", repoRoot: "/repo", key: "x" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Work item not found");
  });

  test("phase_state tools error when no stateDb configured", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    server = new WorkItemsServer(db);
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 5 } });

    const result = await client.callTool({
      name: "phase_state_get",
      arguments: { workItemId: "issue:5", repoRoot: "/repo", key: "x" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("not available");
  });

  test("phase_state_set rejects undefined value", async () => {
    const { db, raw } = createWorkItemDb();
    rawDb = raw;
    const stateDb = createPhaseStateStore(raw);
    server = new WorkItemsServer(db, { stateDb });
    const { client } = await server.start();

    await client.callTool({ name: "work_items_track", arguments: { issueNumber: 6 } });

    const result = await client.callTool({
      name: "phase_state_set",
      arguments: { workItemId: "issue:6", repoRoot: "/repo", key: "k" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("value is required");
  });
});
