import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { StateDb } from "./state";

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
  try {
    unlinkSync(`${path}-wal`);
  } catch {
    // ignore
  }
  try {
    unlinkSync(`${path}-shm`);
  } catch {
    // ignore
  }
}

describe("StateDb", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  function createDb(): StateDb {
    const p = tmpDb();
    paths.push(p);
    return new StateDb(p);
  }

  describe("tool cache", () => {
    test("cacheTools and getCachedTools round-trip", () => {
      const db = createDb();
      const tools = [
        {
          name: "search",
          server: "atlas",
          description: "Search stuff",
          inputSchema: { type: "object" },
          signature: "search({q: string})",
        },
        {
          name: "fetch",
          server: "atlas",
          description: "Fetch page",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
        },
      ];
      db.cacheTools("atlas", tools);

      const cached = db.getCachedTools("atlas");
      expect(cached).toHaveLength(2);
      const byName = new Map(cached.map((t) => [t.name, t]));
      expect(byName.get("search")?.signature).toBe("search({q: string})");
      expect(byName.get("fetch")?.signature).toBeUndefined();
      expect(byName.get("fetch")?.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
      db.close();
    });

    test("cacheTools replaces existing cache", () => {
      const db = createDb();
      db.cacheTools("s1", [{ name: "a", server: "s1", description: "", inputSchema: {} }]);
      db.cacheTools("s1", [{ name: "b", server: "s1", description: "", inputSchema: {} }]);

      const cached = db.getCachedTools("s1");
      expect(cached).toHaveLength(1);
      expect(cached[0].name).toBe("b");
      db.close();
    });

    test("getCachedTools returns empty for unknown server", () => {
      const db = createDb();
      expect(db.getCachedTools("nope")).toEqual([]);
      db.close();
    });

    test("clearCache by server", () => {
      const db = createDb();
      db.cacheTools("s1", [{ name: "a", server: "s1", description: "", inputSchema: {} }]);
      db.cacheTools("s2", [{ name: "b", server: "s2", description: "", inputSchema: {} }]);
      db.clearCache("s1");
      expect(db.getCachedTools("s1")).toHaveLength(0);
      expect(db.getCachedTools("s2")).toHaveLength(1);
      db.close();
    });

    test("clearCache all", () => {
      const db = createDb();
      db.cacheTools("s1", [{ name: "a", server: "s1", description: "", inputSchema: {} }]);
      db.cacheTools("s2", [{ name: "b", server: "s2", description: "", inputSchema: {} }]);
      db.clearCache();
      expect(db.getCachedTools("s1")).toHaveLength(0);
      expect(db.getCachedTools("s2")).toHaveLength(0);
      db.close();
    });

    test("getCachedTools returns empty schema for corrupt JSON", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run(
        "INSERT INTO tool_cache (server_name, tool_name, description, input_schema_json) VALUES (?, ?, ?, ?)",
        ["s1", "broken", "desc", "{invalid json"],
      );
      const cached = db.getCachedTools("s1");
      expect(cached).toHaveLength(1);
      expect(cached[0].inputSchema).toEqual({});
      db.close();
    });
  });

  describe("usage stats", () => {
    test("recordUsage and getUsageStats", () => {
      const db = createDb();
      db.recordUsage("s1", "tool1", 100, true);
      db.recordUsage("s1", "tool1", 200, true);
      db.recordUsage("s1", "tool1", 50, false, "timeout");

      const stats = db.getUsageStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].serverName).toBe("s1");
      expect(stats[0].toolName).toBe("tool1");
      expect(stats[0].callCount).toBe(3);
      expect(stats[0].totalDurationMs).toBe(350);
      expect(stats[0].successCount).toBe(2);
      expect(stats[0].errorCount).toBe(1);
      expect(stats[0].lastError).toBe("timeout");
      db.close();
    });

    test("multiple tools tracked separately", () => {
      const db = createDb();
      db.recordUsage("s1", "a", 10, true);
      db.recordUsage("s1", "b", 20, true);
      db.recordUsage("s2", "a", 30, true);

      const stats = db.getUsageStats();
      expect(stats).toHaveLength(3);
      db.close();
    });

    test("recordUsage with traceContext stores daemon_id, trace_id, parent_id", () => {
      const db = createDb();
      db.recordUsage("s1", "t1", 100, true, undefined, {
        daemonId: "aabbccdd11223344",
        traceId: "00112233445566778899aabbccddeeff",
        parentId: "1122334455667788",
      });

      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const row = db["db"]
        .query<{ daemon_id: string | null; trace_id: string | null; parent_id: string | null }, []>(
          "SELECT daemon_id, trace_id, parent_id FROM usage_stats ORDER BY id DESC LIMIT 1",
        )
        .get();
      expect(row?.daemon_id).toBe("aabbccdd11223344");
      expect(row?.trace_id).toBe("00112233445566778899aabbccddeeff");
      expect(row?.parent_id).toBe("1122334455667788");
      db.close();
    });

    test("recordUsage without traceContext stores NULLs (backward compat)", () => {
      const db = createDb();
      db.recordUsage("s1", "t1", 50, true);

      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const row = db["db"]
        .query<{ daemon_id: string | null; trace_id: string | null; parent_id: string | null }, []>(
          "SELECT daemon_id, trace_id, parent_id FROM usage_stats ORDER BY id DESC LIMIT 1",
        )
        .get();
      expect(row?.daemon_id).toBeNull();
      expect(row?.trace_id).toBeNull();
      expect(row?.parent_id).toBeNull();
      db.close();
    });

    test("pruneUsageStats keeps newest rows and deletes oldest", () => {
      const db = createDb();
      for (let i = 0; i < 150; i++) {
        db.recordUsage("s1", `t${i}`, 10, true);
      }

      const deleted = db.pruneUsageStats(100);
      expect(deleted).toBe(50);

      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const count = db["db"].query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM usage_stats").get();
      expect(count?.cnt).toBe(100);
      db.close();
    });

    test("amortized prune fires at USAGE_PRUNE_INTERVAL", () => {
      const orig = options.USAGE_PRUNE_INTERVAL;
      const origMax = options.USAGE_STATS_MAX_ROWS;
      options.USAGE_PRUNE_INTERVAL = 10;
      options.USAGE_STATS_MAX_ROWS = 5;
      try {
        const db = createDb();
        // Insert 10 rows to trigger amortized prune (interval=10, max=5)
        for (let i = 0; i < 10; i++) {
          db.recordUsage("s1", `t${i}`, 10, true);
        }
        // biome-ignore lint/complexity/useLiteralKeys: access private field for test
        const count = db["db"].query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM usage_stats").get();
        expect(count?.cnt).toBe(5);
        db.close();
      } finally {
        options.USAGE_PRUNE_INTERVAL = orig;
        options.USAGE_STATS_MAX_ROWS = origMax;
      }
    });

    test("getUsageStats works with trace columns present", () => {
      const db = createDb();
      db.recordUsage("s1", "t1", 100, true, undefined, { daemonId: "abc" });
      db.recordUsage("s1", "t1", 200, false, "err");

      const stats = db.getUsageStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].callCount).toBe(2);
      expect(stats[0].successCount).toBe(1);
      expect(stats[0].errorCount).toBe(1);
      db.close();
    });
  });

  describe("daemon state", () => {
    test("getState returns null for missing key", () => {
      const db = createDb();
      expect(db.getState("nope")).toBeNull();
      db.close();
    });

    test("setState and getState round-trip", () => {
      const db = createDb();
      db.setState("configHash", "abc123");
      expect(db.getState("configHash")).toBe("abc123");
      db.close();
    });

    test("setState overwrites existing value", () => {
      const db = createDb();
      db.setState("k", "v1");
      db.setState("k", "v2");
      expect(db.getState("k")).toBe("v2");
      db.close();
    });
  });

  describe("server logs", () => {
    test("insertServerLog and getServerLogs round-trip", () => {
      const db = createDb();
      const now = Date.now();
      db.insertServerLog("srv", "line 1", now);
      db.insertServerLog("srv", "line 2", now + 1);

      const logs = db.getServerLogs("srv");
      expect(logs).toHaveLength(2);
      expect(logs[0].line).toBe("line 1");
      expect(logs[1].line).toBe("line 2");
      expect(logs[0].timestampMs).toBe(now);
      db.close();
    });

    test("getServerLogs with limit", () => {
      const db = createDb();
      const now = Date.now();
      db.insertServerLog("srv", "a", now);
      db.insertServerLog("srv", "b", now + 1);
      db.insertServerLog("srv", "c", now + 2);

      const logs = db.getServerLogs("srv", 2);
      expect(logs).toHaveLength(2);
      expect(logs[0].line).toBe("a");
      expect(logs[1].line).toBe("b");
      db.close();
    });

    test("getServerLogs with since filter", () => {
      const db = createDb();
      const now = Date.now();
      db.insertServerLog("srv", "old", now);
      db.insertServerLog("srv", "new", now + 100);

      const logs = db.getServerLogs("srv", undefined, now);
      expect(logs).toHaveLength(1);
      expect(logs[0].line).toBe("new");
      db.close();
    });

    test("getServerLogs returns empty for unknown server", () => {
      const db = createDb();
      expect(db.getServerLogs("nope")).toEqual([]);
      db.close();
    });

    test("clearServerLogs by server", () => {
      const db = createDb();
      const now = Date.now();
      db.insertServerLog("s1", "a", now);
      db.insertServerLog("s2", "b", now);
      db.clearServerLogs("s1");

      expect(db.getServerLogs("s1")).toHaveLength(0);
      expect(db.getServerLogs("s2")).toHaveLength(1);
      db.close();
    });

    test("clearServerLogs all", () => {
      const db = createDb();
      const now = Date.now();
      db.insertServerLog("s1", "a", now);
      db.insertServerLog("s2", "b", now);
      db.clearServerLogs();

      expect(db.getServerLogs("s1")).toHaveLength(0);
      expect(db.getServerLogs("s2")).toHaveLength(0);
      db.close();
    });

    test("prunes to 500 rows per server (batched every 100 inserts)", () => {
      const db = createDb();
      const now = Date.now();
      // Insert 600 rows — prune fires at 100, 200, ..., 600
      // At insert 600: 600 rows exist, prune keeps newest 500
      for (let i = 0; i < 600; i++) {
        db.insertServerLog("srv", `line-${i}`, now + i);
      }

      const logs = db.getServerLogs("srv");
      expect(logs.length).toBeLessThanOrEqual(500);
      // Oldest 100 lines should have been pruned
      expect(logs[0].line).toBe("line-100");
      db.close();
    });
  });

  describe("aliases", () => {
    test("saveAlias and listAliases round-trip", () => {
      const db = createDb();
      db.saveAlias("greet", "/tmp/greet.ts", "Say hello");
      db.saveAlias("fetch", "/tmp/fetch.ts");

      const aliases = db.listAliases();
      expect(aliases).toHaveLength(2);
      expect(aliases[0].name).toBe("fetch"); // ORDER BY name
      expect(aliases[1].name).toBe("greet");
      expect(aliases[1].description).toBe("Say hello");
      expect(aliases[1].filePath).toBe("/tmp/greet.ts");
      db.close();
    });

    test("getAlias returns alias by name", () => {
      const db = createDb();
      db.saveAlias("greet", "/tmp/greet.ts", "Say hello");

      const alias = db.getAlias("greet");
      expect(alias).toBeDefined();
      expect(alias?.name).toBe("greet");
      expect(alias?.description).toBe("Say hello");
      expect(alias?.filePath).toBe("/tmp/greet.ts");
      db.close();
    });

    test("getAlias returns undefined for unknown name", () => {
      const db = createDb();
      expect(db.getAlias("nope")).toBeUndefined();
      db.close();
    });

    test("saveAlias upserts on conflict", () => {
      const db = createDb();
      db.saveAlias("greet", "/tmp/greet-v1.ts", "version 1");
      db.saveAlias("greet", "/tmp/greet-v2.ts", "version 2");

      const aliases = db.listAliases();
      expect(aliases).toHaveLength(1);
      expect(aliases[0].filePath).toBe("/tmp/greet-v2.ts");
      expect(aliases[0].description).toBe("version 2");
      db.close();
    });

    test("saveAlias with no description stores null", () => {
      const db = createDb();
      db.saveAlias("minimal", "/tmp/min.ts");

      const alias = db.getAlias("minimal");
      expect(alias).toBeDefined();
      expect(alias?.description).toBe("");
      db.close();
    });

    test("deleteAlias removes by name", () => {
      const db = createDb();
      db.saveAlias("keep", "/tmp/keep.ts");
      db.saveAlias("remove", "/tmp/remove.ts");
      db.deleteAlias("remove");

      expect(db.listAliases()).toHaveLength(1);
      expect(db.getAlias("remove")).toBeUndefined();
      expect(db.getAlias("keep")).toBeDefined();
      db.close();
    });

    test("deleteAlias is a no-op for unknown name", () => {
      const db = createDb();
      db.saveAlias("exists", "/tmp/exists.ts");
      db.deleteAlias("nope"); // should not throw
      expect(db.listAliases()).toHaveLength(1);
      db.close();
    });

    test("listAliases returns empty for fresh db", () => {
      const db = createDb();
      expect(db.listAliases()).toEqual([]);
      db.close();
    });

    test("listAliases returns empty schema for corrupt schema JSON", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run(
        `INSERT INTO aliases (name, file_path, description, alias_type, input_schema_json, output_schema_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
        ["broken", "/tmp/broken.ts", "desc", "defineAlias", "not{json", "also{bad"],
      );
      const aliases = db.listAliases();
      expect(aliases).toHaveLength(1);
      expect(aliases[0].inputSchemaJson).toEqual({});
      expect(aliases[0].outputSchemaJson).toEqual({});
      db.close();
    });

    test("saveAlias stores aliasType as defineAlias", () => {
      const db = createDb();
      db.saveAlias("structured", "/tmp/structured.ts", "A defined alias", "defineAlias");
      const alias = db.getAlias("structured");
      expect(alias?.aliasType).toBe("defineAlias");
      db.close();
    });

    test("saveAlias defaults aliasType to freeform", () => {
      const db = createDb();
      db.saveAlias("legacy", "/tmp/legacy.ts");
      const alias = db.getAlias("legacy");
      expect(alias?.aliasType).toBe("freeform");
      db.close();
    });

    test("listAliases includes aliasType", () => {
      const db = createDb();
      db.saveAlias("a", "/tmp/a.ts", undefined, "freeform");
      db.saveAlias("b", "/tmp/b.ts", undefined, "defineAlias");
      const aliases = db.listAliases();
      expect(aliases[0].aliasType).toBe("freeform");
      expect(aliases[1].aliasType).toBe("defineAlias");
      db.close();
    });

    test("saveAlias stores schema JSON", () => {
      const db = createDb();
      const inputSchema = '{"type":"object","properties":{"q":{"type":"string"}}}';
      db.saveAlias("search", "/tmp/search.ts", "Search", "defineAlias", inputSchema, '{"type":"string"}');
      const alias = db.getAlias("search");
      expect(alias).toBeDefined();
      expect(alias?.aliasType).toBe("defineAlias");
      db.close();
    });

    test("upsert updates aliasType", () => {
      const db = createDb();
      db.saveAlias("evolve", "/tmp/evolve.ts", "v1", "freeform");
      expect(db.getAlias("evolve")?.aliasType).toBe("freeform");
      db.saveAlias("evolve", "/tmp/evolve.ts", "v2", "defineAlias");
      expect(db.getAlias("evolve")?.aliasType).toBe("defineAlias");
      db.close();
    });

    test("saveAlias with expiresAt stores ephemeral alias", () => {
      const db = createDb();
      const future = Date.now() + 86400000;
      db.saveAlias(
        "eph-1",
        "/tmp/eph-1.ts",
        "ephemeral test",
        "freeform",
        undefined,
        undefined,
        undefined,
        undefined,
        future,
      );
      const alias = db.getAlias("eph-1");
      expect(alias).toBeDefined();
      expect(alias?.expiresAt).toBe(future);
      db.close();
    });

    test("listAliases excludes expired aliases", () => {
      const db = createDb();
      const past = Date.now() - 1000;
      const future = Date.now() + 86400000;
      db.saveAlias("permanent", "/tmp/p.ts", "stays");
      db.saveAlias("expired", "/tmp/e.ts", "gone", "freeform", undefined, undefined, undefined, undefined, past);
      db.saveAlias("alive", "/tmp/a.ts", "still here", "freeform", undefined, undefined, undefined, undefined, future);

      const aliases = db.listAliases();
      const names = aliases.map((a) => a.name);
      expect(names).toContain("permanent");
      expect(names).toContain("alive");
      expect(names).not.toContain("expired");
      db.close();
    });

    test("listAliases returns expiresAt for ephemeral aliases", () => {
      const db = createDb();
      const future = Date.now() + 86400000;
      db.saveAlias("permanent", "/tmp/p.ts", "stays");
      db.saveAlias("ephemeral", "/tmp/e.ts", "temp", "freeform", undefined, undefined, undefined, undefined, future);

      const aliases = db.listAliases();
      const permanent = aliases.find((a) => a.name === "permanent");
      const ephemeral = aliases.find((a) => a.name === "ephemeral");
      expect(permanent?.expiresAt).toBeNull();
      expect(ephemeral?.expiresAt).toBe(future);
      db.close();
    });

    test("touchAliasExpiry resets TTL on ephemeral alias", () => {
      const db = createDb();
      const original = Date.now() + 1000;
      const newExpiry = Date.now() + 86400000;
      db.saveAlias("eph", "/tmp/eph.ts", "temp", "freeform", undefined, undefined, undefined, undefined, original);

      db.touchAliasExpiry("eph", newExpiry);
      const alias = db.getAlias("eph");
      expect(alias?.expiresAt).toBe(newExpiry);
      db.close();
    });

    test("touchAliasExpiry does not affect permanent aliases", () => {
      const db = createDb();
      db.saveAlias("perm", "/tmp/perm.ts", "permanent");

      db.touchAliasExpiry("perm", Date.now() + 86400000);
      const alias = db.getAlias("perm");
      expect(alias?.expiresAt).toBeNull();
      db.close();
    });

    test("pruneExpiredAliases removes only expired aliases", () => {
      const db = createDb();
      const past = Date.now() - 1000;
      const future = Date.now() + 86400000;
      db.saveAlias("permanent", "/tmp/p.ts", "stays");
      db.saveAlias("expired", "/tmp/e.ts", "gone", "freeform", undefined, undefined, undefined, undefined, past);
      db.saveAlias("alive", "/tmp/a.ts", "still here", "freeform", undefined, undefined, undefined, undefined, future);

      const pruned = db.pruneExpiredAliases();
      expect(pruned).toBe(1);

      expect(db.getAlias("permanent")).toBeDefined();
      expect(db.getAlias("alive")).toBeDefined();
      expect(db.getAlias("expired")).toBeUndefined();
      db.close();
    });

    test("pruneExpiredAliases cleans up alias files", () => {
      const db = createDb();
      const tmpFile = join(tmpdir(), `mcp-cli-test-prune-${Date.now()}.ts`);
      // Create a real file so unlinkSync has something to delete
      const { writeFileSync } = require("node:fs");
      const { existsSync } = require("node:fs");
      writeFileSync(tmpFile, "// ephemeral alias");

      const past = Date.now() - 1000;
      db.saveAlias("eph-file", tmpFile, "gone", "freeform", undefined, undefined, undefined, undefined, past);

      expect(existsSync(tmpFile)).toBe(true);
      db.pruneExpiredAliases();
      expect(existsSync(tmpFile)).toBe(false);
      db.close();
    });

    test("saveAlias with expiresAt refuses to overwrite permanent alias", () => {
      const db = createDb();
      // Save a permanent alias
      db.saveAlias("my-tool", "/tmp/permanent.ts", "user curated");
      expect(db.getAlias("my-tool")?.expiresAt).toBeNull();

      // Attempt to overwrite with an ephemeral alias
      const future = Date.now() + 86400000;
      db.saveAlias(
        "my-tool",
        "/tmp/ephemeral.ts",
        "ephemeral",
        "freeform",
        undefined,
        undefined,
        undefined,
        undefined,
        future,
      );

      // Permanent alias should be unchanged
      const alias = db.getAlias("my-tool");
      expect(alias?.description).toBe("user curated");
      expect(alias?.filePath).toBe("/tmp/permanent.ts");
      expect(alias?.expiresAt).toBeNull();
      db.close();
    });

    test("saveAlias without expiresAt can still overwrite permanent alias", () => {
      const db = createDb();
      db.saveAlias("my-tool", "/tmp/v1.ts", "version 1");
      db.saveAlias("my-tool", "/tmp/v2.ts", "version 2");
      expect(db.getAlias("my-tool")?.description).toBe("version 2");
      db.close();
    });

    test("saveAlias with expiresAt can overwrite another ephemeral alias", () => {
      const db = createDb();
      const future1 = Date.now() + 86400000;
      const future2 = Date.now() + 172800000;
      db.saveAlias("eph-x", "/tmp/e1.ts", "first", "freeform", undefined, undefined, undefined, undefined, future1);
      db.saveAlias("eph-x", "/tmp/e2.ts", "second", "freeform", undefined, undefined, undefined, undefined, future2);
      const alias = db.getAlias("eph-x");
      expect(alias?.description).toBe("second");
      expect(alias?.expiresAt).toBe(future2);
      db.close();
    });

    test("recordAliasRun increments run_count", () => {
      const db = createDb();
      db.saveAlias("runner", "/tmp/runner.ts", "test");

      expect(db.recordAliasRun("runner")).toBe(1);
      expect(db.recordAliasRun("runner")).toBe(2);
      expect(db.recordAliasRun("runner")).toBe(3);

      const alias = db.getAlias("runner");
      expect(alias?.runCount).toBe(3);
      db.close();
    });

    test("recordAliasRun sets last_run_at", () => {
      const db = createDb();
      db.saveAlias("runner2", "/tmp/runner2.ts");

      const alias1 = db.getAlias("runner2");
      expect(alias1?.lastRunAt).toBeNull();

      db.recordAliasRun("runner2");
      const alias2 = db.getAlias("runner2");
      expect(alias2?.lastRunAt).toBeGreaterThan(0);
      db.close();
    });

    test("recordAliasRun returns 0 for unknown alias", () => {
      const db = createDb();
      expect(db.recordAliasRun("nonexistent")).toBe(0);
      db.close();
    });

    test("listAliases includes runCount and lastRunAt", () => {
      const db = createDb();
      db.saveAlias("counted", "/tmp/counted.ts", "test");
      db.recordAliasRun("counted");

      const aliases = db.listAliases();
      const alias = aliases.find((a) => a.name === "counted");
      expect(alias?.runCount).toBe(1);
      expect(alias?.lastRunAt).toBeGreaterThan(0);
      db.close();
    });

    test("new alias has runCount 0 and lastRunAt null", () => {
      const db = createDb();
      db.saveAlias("fresh", "/tmp/fresh.ts");
      const alias = db.getAlias("fresh");
      expect(alias?.runCount).toBe(0);
      expect(alias?.lastRunAt).toBeNull();
      db.close();
    });
  });

  describe("auth_tokens", () => {
    test("saveTokens and getTokens round-trip", () => {
      const db = createDb();
      db.saveTokens("srv", {
        access_token: "acc-123",
        token_type: "Bearer",
        refresh_token: "ref-456",
        scope: "read write",
        expires_in: 3600,
      });

      const tokens = db.getTokens("srv");
      expect(tokens).toBeDefined();
      expect(tokens?.access_token).toBe("acc-123");
      expect(tokens?.token_type).toBe("Bearer");
      expect(tokens?.refresh_token).toBe("ref-456");
      expect(tokens?.scope).toBe("read write");
      // expires_in is converted to absolute then back to relative, so just check > 0
      expect(tokens?.expires_in).toBeGreaterThan(0);
      db.close();
    });

    test("expires_in converts to absolute timestamp and back", () => {
      const db = createDb();
      db.saveTokens("srv", {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 7200,
      });

      const tokens = db.getTokens("srv");
      // Should be roughly 7200s minus tiny elapsed time
      expect(tokens?.expires_in).toBeGreaterThan(7190);
      expect(tokens?.expires_in).toBeLessThanOrEqual(7200);
      db.close();
    });

    test("upsert replaces existing tokens", () => {
      const db = createDb();
      db.saveTokens("srv", { access_token: "old", token_type: "Bearer" });
      db.saveTokens("srv", { access_token: "new", token_type: "Bearer" });

      const tokens = db.getTokens("srv");
      expect(tokens?.access_token).toBe("new");
      db.close();
    });

    test("getTokens returns undefined for missing server", () => {
      const db = createDb();
      expect(db.getTokens("nope")).toBeUndefined();
      db.close();
    });

    test("deleteTokens removes tokens", () => {
      const db = createDb();
      db.saveTokens("srv", { access_token: "tok", token_type: "Bearer" });
      db.deleteTokens("srv");
      expect(db.getTokens("srv")).toBeUndefined();
      db.close();
    });

    test("omits optional fields when not stored", () => {
      const db = createDb();
      db.saveTokens("srv", { access_token: "tok", token_type: "Bearer" });

      const tokens = db.getTokens("srv");
      expect(tokens?.access_token).toBe("tok");
      expect(tokens?.refresh_token).toBeUndefined();
      expect(tokens?.scope).toBeUndefined();
      expect(tokens?.expires_in).toBeUndefined();
      db.close();
    });
  });

  describe("oauth_clients", () => {
    test("saveClientInfo and getClientInfo round-trip", () => {
      const db = createDb();
      db.saveClientInfo("srv", { client_id: "cid-123" });

      const info = db.getClientInfo("srv");
      expect(info).toBeDefined();
      expect(info?.client_id).toBe("cid-123");
      db.close();
    });

    test("stores full client info as JSON", () => {
      const db = createDb();
      const fullInfo = {
        client_id: "cid",
        client_secret: "secret-abc",
        redirect_uris: ["http://localhost:9999/callback"],
      };
      db.saveClientInfo("srv", fullInfo as Record<string, unknown> & { client_id: string });

      const info = db.getClientInfo("srv");
      expect(info).toEqual(fullInfo);
      db.close();
    });

    test("upsert replaces existing client info", () => {
      const db = createDb();
      db.saveClientInfo("srv", { client_id: "old" });
      db.saveClientInfo("srv", { client_id: "new" });

      const info = db.getClientInfo("srv");
      expect(info?.client_id).toBe("new");
      db.close();
    });

    test("getClientInfo returns undefined for missing server", () => {
      const db = createDb();
      expect(db.getClientInfo("nope")).toBeUndefined();
      db.close();
    });

    test("getClientInfo falls back to basic fields on corrupt JSON", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run(
        "INSERT INTO oauth_clients (server_name, client_id, client_secret, client_info_json, created_at) VALUES (?, ?, ?, ?, unixepoch())",
        ["srv", "cid-123", "secret", "not valid json"],
      );
      const info = db.getClientInfo("srv");
      expect(info).toBeDefined();
      expect(info?.client_id).toBe("cid-123");
      db.close();
    });
  });

  describe("saveClientInfoAndTokens", () => {
    test("persists both client info and tokens atomically", () => {
      const db = createDb();
      db.saveClientInfoAndTokens(
        "srv",
        { client_id: "cid", client_secret: "sec" },
        { access_token: "tok", token_type: "Bearer" },
      );

      expect(db.getClientInfo("srv")?.client_id).toBe("cid");
      expect(db.getTokens("srv")?.access_token).toBe("tok");
      db.close();
    });

    test("rolls back client info if token INSERT fails", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const rawDb = db["db"];
      rawDb.run("DROP TABLE auth_tokens");
      rawDb.run(
        "CREATE TABLE auth_tokens (server_name TEXT PRIMARY KEY, access_token TEXT NOT NULL CHECK(length(access_token) > 1000))",
      );

      expect(() => {
        db.saveClientInfoAndTokens("srv", { client_id: "cid" }, { access_token: "tok", token_type: "Bearer" });
      }).toThrow();

      expect(db.getClientInfo("srv")).toBeUndefined();
      db.close();
    });
  });

  describe("oauth_verifiers", () => {
    test("saveVerifier and getVerifier round-trip", () => {
      const db = createDb();
      db.saveVerifier("srv", "pkce-verifier-123");

      expect(db.getVerifier("srv")).toBe("pkce-verifier-123");
      db.close();
    });

    test("upsert replaces existing verifier", () => {
      const db = createDb();
      db.saveVerifier("srv", "old-verifier");
      db.saveVerifier("srv", "new-verifier");

      expect(db.getVerifier("srv")).toBe("new-verifier");
      db.close();
    });

    test("getVerifier returns undefined for missing server", () => {
      const db = createDb();
      expect(db.getVerifier("nope")).toBeUndefined();
      db.close();
    });
  });

  describe("oauth_discovery", () => {
    test("saveDiscoveryState and getDiscoveryState round-trip", () => {
      const db = createDb();
      const state = { authorizationServerUrl: "https://auth.example.com" };
      db.saveDiscoveryState("srv", state);

      expect(db.getDiscoveryState("srv")).toEqual(state);
      db.close();
    });

    test("stores complex discovery state as JSON", () => {
      const db = createDb();
      // Use a state with extra fields to verify JSON round-trip preserves all data
      const state = {
        authorizationServerUrl: "https://auth.example.com",
        resourceMetadataUrl: "https://resource.example.com/.well-known/oauth-protected-resource",
      };
      db.saveDiscoveryState("srv", state);

      expect(db.getDiscoveryState("srv")).toEqual(state);
      db.close();
    });

    test("upsert replaces existing discovery state", () => {
      const db = createDb();
      db.saveDiscoveryState("srv", { authorizationServerUrl: "https://old.com" });
      db.saveDiscoveryState("srv", { authorizationServerUrl: "https://new.com" });

      expect(db.getDiscoveryState("srv")).toEqual({ authorizationServerUrl: "https://new.com" });
      db.close();
    });

    test("getDiscoveryState returns undefined for missing server", () => {
      const db = createDb();
      expect(db.getDiscoveryState("nope")).toBeUndefined();
      db.close();
    });

    test("getDiscoveryState returns undefined for corrupt JSON", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run("INSERT INTO oauth_discovery (server_name, state_json, updated_at) VALUES (?, ?, unixepoch())", [
        "srv",
        "corrupt{",
      ]);
      expect(db.getDiscoveryState("srv")).toBeUndefined();
      db.close();
    });
  });

  describe("mail", () => {
    test("insertMail and readMail round-trip", () => {
      const db = createDb();
      const id = db.insertMail("wt-1", "manager", "done", "tests pass");
      expect(id).toBeGreaterThan(0);

      const messages = db.readMail();
      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe("wt-1");
      expect(messages[0].recipient).toBe("manager");
      expect(messages[0].subject).toBe("done");
      expect(messages[0].body).toBe("tests pass");
      expect(messages[0].read).toBe(false);
      db.close();
    });

    test("readMail filters by recipient", () => {
      const db = createDb();
      db.insertMail("wt-1", "manager", "for manager");
      db.insertMail("wt-1", "wt-2", "for wt-2");

      const managerMail = db.readMail("manager");
      expect(managerMail).toHaveLength(1);
      expect(managerMail[0].subject).toBe("for manager");
      db.close();
    });

    test("readMail includes broadcast messages", () => {
      const db = createDb();
      db.insertMail("admin", "*", "broadcast");
      db.insertMail("wt-1", "manager", "direct");

      const managerMail = db.readMail("manager");
      expect(managerMail).toHaveLength(2);
      db.close();
    });

    test("readMail filters unread only", () => {
      const db = createDb();
      const id1 = db.insertMail("a", "b", "unread");
      db.insertMail("a", "b", "also unread");
      db.markMailRead(id1);

      const unread = db.readMail("b", true);
      expect(unread).toHaveLength(1);
      expect(unread[0].subject).toBe("also unread");
      db.close();
    });

    test("readMail respects limit", () => {
      const db = createDb();
      db.insertMail("a", "b", "msg1");
      db.insertMail("a", "b", "msg2");
      db.insertMail("a", "b", "msg3");

      const limited = db.readMail("b", false, 2);
      expect(limited).toHaveLength(2);
      db.close();
    });

    test("getMailById returns message", () => {
      const db = createDb();
      const id = db.insertMail("x", "y", "test", "body text");

      const msg = db.getMailById(id);
      expect(msg).toBeDefined();
      expect(msg?.id).toBe(id);
      expect(msg?.body).toBe("body text");
      db.close();
    });

    test("getMailById returns undefined for missing id", () => {
      const db = createDb();
      expect(db.getMailById(9999)).toBeUndefined();
      db.close();
    });

    test("getNextUnread returns oldest unread", () => {
      const db = createDb();
      db.insertMail("a", "b", "first");
      db.insertMail("a", "b", "second");

      const next = db.getNextUnread("b");
      expect(next?.subject).toBe("first");
      db.close();
    });

    test("getNextUnread filters by recipient", () => {
      const db = createDb();
      db.insertMail("a", "other", "not for b");
      db.insertMail("a", "b", "for b");

      const next = db.getNextUnread("b");
      expect(next?.subject).toBe("for b");
      db.close();
    });

    test("getNextUnread returns undefined when all read", () => {
      const db = createDb();
      const id = db.insertMail("a", "b", "read");
      db.markMailRead(id);

      expect(db.getNextUnread("b")).toBeUndefined();
      db.close();
    });

    test("getNextUnread includes broadcast", () => {
      const db = createDb();
      db.insertMail("admin", "*", "broadcast");

      const next = db.getNextUnread("anyone");
      expect(next?.subject).toBe("broadcast");
      db.close();
    });

    test("markMailRead marks message as read", () => {
      const db = createDb();
      const id = db.insertMail("a", "b", "test");

      expect(db.getMailById(id)?.read).toBe(false);
      db.markMailRead(id);
      expect(db.getMailById(id)?.read).toBe(true);
      db.close();
    });

    test("insertMail with replyTo sets threading", () => {
      const db = createDb();
      const original = db.insertMail("a", "b", "original");
      const reply = db.insertMail("b", "a", "reply", "body", original);

      const msg = db.getMailById(reply);
      expect(msg?.replyTo).toBe(original);
      db.close();
    });

    test("reply-to-sender smoke: worker→manager→reply is picked up by getNextUnread", () => {
      const db = createDb();

      // 1. Worker sends mail to manager
      const origId = db.insertMail("wt-262", "manager", "stopped", "tests pass");

      // 2. Manager reads and marks as read
      const orig = db.getMailById(origId);
      expect(orig?.sender).toBe("wt-262");
      expect(orig?.recipient).toBe("manager");
      db.markMailRead(origId);

      // 3. Manager replies — recipient should be original sender
      const replyId = db.insertMail(
        "manager",
        orig?.sender ?? "",
        `Re: ${orig?.subject}`,
        "looks good, continue",
        origId,
      );
      const reply = db.getMailById(replyId);
      expect(reply?.sender).toBe("manager");
      expect(reply?.recipient).toBe("wt-262");
      expect(reply?.replyTo).toBe(origId);

      // 4. Worker polls for unread mail addressed to wt-262
      const next = db.getNextUnread("wt-262");
      expect(next).toBeDefined();
      expect(next?.id).toBe(replyId);
      expect(next?.body).toBe("looks good, continue");

      db.close();
    });

    test("insertMail with no optional fields", () => {
      const db = createDb();
      const id = db.insertMail("a", "b");

      const msg = db.getMailById(id);
      expect(msg?.subject).toBeNull();
      expect(msg?.body).toBeNull();
      expect(msg?.replyTo).toBeNull();
      db.close();
    });

    test("pruneExpiredMail deletes read messages older than TTL", () => {
      const db = createDb();
      const id1 = db.insertMail("a", "b", "old-read");
      const id2 = db.insertMail("a", "b", "old-unread");
      const id3 = db.insertMail("a", "b", "recent-read");

      // Backdate id1 and id2 to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test backdating
      db["db"].run("UPDATE mail SET created_at = ? WHERE id IN (?, ?)", [twoDaysAgo, id1, id2]);

      // Mark id1 and id3 as read
      db.markMailRead(id1);
      db.markMailRead(id3);

      // Prune with 1-day TTL — should only delete id1 (read + old)
      const pruned = db.pruneExpiredMail(1 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(1);

      // id1 gone, id2 (unread) and id3 (recent) remain
      expect(db.getMailById(id1)).toBeUndefined();
      expect(db.getMailById(id2)).toBeDefined();
      expect(db.getMailById(id3)).toBeDefined();
      db.close();
    });

    test("pruneExpiredMail never deletes unread messages", () => {
      const db = createDb();
      const id = db.insertMail("a", "b", "ancient-unread");

      // Backdate to 30 days ago
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test backdating
      db["db"].run("UPDATE mail SET created_at = ? WHERE id = ?", [old, id]);

      const pruned = db.pruneExpiredMail(1000);
      expect(pruned).toBe(0);
      expect(db.getMailById(id)).toBeDefined();
      db.close();
    });

    test("pruneExpiredMail uses options.MAIL_TTL_MS by default", () => {
      const db = createDb();
      const id = db.insertMail("a", "b", "old-read");
      db.markMailRead(id);

      // Backdate to 8 days ago (beyond default 7d TTL)
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test backdating
      db["db"].run("UPDATE mail SET created_at = ? WHERE id = ?", [old, id]);

      const pruned = db.pruneExpiredMail();
      expect(pruned).toBe(1);
      db.close();
    });

    test("amortized prune fires every 50 mail operations", () => {
      const saved = options.MAIL_TTL_MS;
      options.MAIL_TTL_MS = 1000; // 1 second TTL
      try {
        const db = createDb();

        // Insert an old read message that should be pruned
        const oldId = db.insertMail("a", "b", "old");
        db.markMailRead(oldId);
        const old = new Date(Date.now() - 5000).toISOString().replace("T", " ").slice(0, 19);
        // biome-ignore lint/complexity/useLiteralKeys: access private field for test backdating
        db["db"].run("UPDATE mail SET created_at = ? WHERE id = ?", [old, oldId]);

        // Do 49 more insertMail calls (first one already counted)
        for (let i = 0; i < 49; i++) {
          db.insertMail("a", "b", `msg-${i}`);
        }

        // At 50 ops the prune should have fired — old message gone
        expect(db.getMailById(oldId)).toBeUndefined();
        db.close();
      } finally {
        options.MAIL_TTL_MS = saved;
      }
    });
  });

  describe("claude_sessions → agent_sessions migration", () => {
    test("migrates existing claude_sessions data to agent_sessions with provider column", () => {
      const p = tmpDb();
      paths.push(p);

      // Simulate a pre-migration database with the old claude_sessions table
      const { Database } = require("bun:sqlite");
      const raw = new Database(p, { create: true });
      raw.exec(`
        CREATE TABLE claude_sessions (
          session_id   TEXT PRIMARY KEY,
          pid          INTEGER,
          state        TEXT NOT NULL DEFAULT 'connecting',
          model        TEXT,
          cwd          TEXT,
          worktree     TEXT,
          total_cost   REAL NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          spawned_at   TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at     TEXT
        )
      `);
      raw.run(
        "INSERT INTO claude_sessions (session_id, pid, state, model, cwd, total_cost, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["old-sess-1", 9999, "ended", "opus", "/home/user", 1.23, 50000],
      );
      raw.close();

      // Now open via StateDb which runs migrations
      const db = new StateDb(p);

      // Old data should be accessible via the new table
      const session = db.getSession("old-sess-1");
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe("old-sess-1");
      expect(session?.provider).toBe("claude"); // default from migration
      expect(session?.pid).toBe(9999);
      expect(session?.state).toBe("ended");
      expect(session?.model).toBe("opus");
      expect(session?.totalCost).toBe(1.23);
      expect(session?.totalTokens).toBe(50000);

      // claude_sessions should no longer exist (renamed)
      expect(() => raw.exec?.("SELECT * FROM claude_sessions")).toThrow();

      db.close();
    });
  });

  describe("claude sessions", () => {
    test("upsertSession and getSession round-trip", () => {
      const db = createDb();
      db.upsertSession({
        sessionId: "sess-1",
        pid: 1234,
        state: "active",
        model: "opus",
        cwd: "/tmp",
        worktree: "wt-1",
      });

      const session = db.getSession("sess-1");
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe("sess-1");
      expect(session?.provider).toBe("claude");
      expect(session?.pid).toBe(1234);
      expect(session?.state).toBe("active");
      expect(session?.model).toBe("opus");
      expect(session?.cwd).toBe("/tmp");
      expect(session?.worktree).toBe("wt-1");
      expect(session?.totalCost).toBe(0);
      expect(session?.totalTokens).toBe(0);
      expect(session?.spawnedAt).toBeTruthy();
      expect(session?.endedAt).toBeNull();
      db.close();
    });

    test("upsertSession with minimal fields", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "sess-min" });

      const session = db.getSession("sess-min");
      expect(session?.state).toBe("connecting");
      expect(session?.pid).toBeNull();
      expect(session?.model).toBeNull();
      expect(session?.cwd).toBeNull();
      expect(session?.worktree).toBeNull();
      db.close();
    });

    test("upsertSession updates existing session without overwriting unset fields", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "sess-u", pid: 100, model: "opus", cwd: "/a" });
      db.upsertSession({ sessionId: "sess-u", state: "active", model: "sonnet" });

      const session = db.getSession("sess-u");
      expect(session?.pid).toBe(100); // preserved
      expect(session?.state).toBe("active"); // updated
      expect(session?.model).toBe("sonnet"); // updated
      expect(session?.cwd).toBe("/a"); // preserved
      db.close();
    });

    test("getSession returns null for unknown id", () => {
      const db = createDb();
      expect(db.getSession("nope")).toBeNull();
      db.close();
    });

    test("updateSessionState changes state", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "sess-s", state: "connecting" });
      db.updateSessionState("sess-s", "active");

      expect(db.getSession("sess-s")?.state).toBe("active");
      db.close();
    });

    test("updateSessionCost sets cost and tokens", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "sess-c" });
      db.updateSessionCost("sess-c", 0.05, 1500);

      const session = db.getSession("sess-c");
      expect(session?.totalCost).toBe(0.05);
      expect(session?.totalTokens).toBe(1500);
      db.close();
    });

    test("endSession sets state and ended_at", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "sess-e", state: "active" });
      db.endSession("sess-e");

      const session = db.getSession("sess-e");
      expect(session?.state).toBe("ended");
      expect(session?.endedAt).toBeTruthy();
      db.close();
    });

    test("listSessions returns all sessions", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "s1", state: "active" });
      db.upsertSession({ sessionId: "s2", state: "active" });
      db.endSession("s2");

      const all = db.listSessions();
      expect(all).toHaveLength(2);
      db.close();
    });

    test("listSessions active=true filters ended sessions", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "s1", state: "active" });
      db.upsertSession({ sessionId: "s2", state: "active" });
      db.endSession("s2");

      const active = db.listSessions(true);
      expect(active).toHaveLength(1);
      expect(active[0].sessionId).toBe("s1");
      db.close();
    });

    test("listSessions active=false returns only ended sessions", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "s1", state: "active" });
      db.upsertSession({ sessionId: "s2", state: "active" });
      db.endSession("s2");

      const ended = db.listSessions(false);
      expect(ended).toHaveLength(1);
      expect(ended[0].sessionId).toBe("s2");
      db.close();
    });

    test("listSessions orders by spawned_at DESC", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "old" });
      // Backdate the first session
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run("UPDATE agent_sessions SET spawned_at = '2024-01-01 00:00:00' WHERE session_id = 'old'");
      db.upsertSession({ sessionId: "new" });

      const sessions = db.listSessions();
      expect(sessions[0].sessionId).toBe("new");
      expect(sessions[1].sessionId).toBe("old");
      db.close();
    });

    test("pruneOldSessions deletes ended sessions older than threshold", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "old-ended" });
      db.endSession("old-ended");
      // Backdate ended_at to 60 days ago
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run("UPDATE agent_sessions SET ended_at = ? WHERE session_id = 'old-ended'", [old]);

      db.upsertSession({ sessionId: "recent-ended" });
      db.endSession("recent-ended");

      db.upsertSession({ sessionId: "still-active" });

      const pruned = db.pruneOldSessions(30);
      expect(pruned).toBe(1);
      expect(db.getSession("old-ended")).toBeNull();
      expect(db.getSession("recent-ended")).not.toBeNull();
      expect(db.getSession("still-active")).not.toBeNull();
      db.close();
    });

    test("pruneOldSessions never deletes active sessions", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "active" });
      // Backdate spawned_at but don't end it
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run("UPDATE agent_sessions SET spawned_at = '2020-01-01 00:00:00' WHERE session_id = 'active'");

      const pruned = db.pruneOldSessions(1);
      expect(pruned).toBe(0);
      expect(db.getSession("active")).not.toBeNull();
      db.close();
    });

    test("pruneOldSessions defaults to 30 days", () => {
      const db = createDb();
      db.upsertSession({ sessionId: "old" });
      db.endSession("old");
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      db["db"].run("UPDATE agent_sessions SET ended_at = ? WHERE session_id = 'old'", [old]);

      const pruned = db.pruneOldSessions();
      expect(pruned).toBe(1);
      db.close();
    });
  });

  describe("spans", () => {
    function makeSpan(overrides?: Partial<import("@mcp-cli/core").Span>): import("@mcp-cli/core").Span {
      return {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: undefined,
        traceFlags: "01",
        name: "ipc.callTool",
        startTimeMs: 1700000000000,
        endTimeMs: 1700000000050,
        durationMs: 50,
        status: "OK",
        attributes: {},
        events: [],
        ...overrides,
      };
    }

    test("recordSpan and getSpans round-trip", () => {
      const db = createDb();
      const span = makeSpan();
      db.recordSpan(span, "daemon-1");

      const rows = db.getSpans();
      expect(rows).toHaveLength(1);
      expect(rows[0].traceId).toBe("a".repeat(32));
      expect(rows[0].spanId).toBe("b".repeat(16));
      expect(rows[0].parentSpanId).toBeNull();
      expect(rows[0].traceFlags).toBe("01");
      expect(rows[0].name).toBe("ipc.callTool");
      expect(rows[0].startTimeMs).toBe(1700000000000);
      expect(rows[0].endTimeMs).toBe(1700000000050);
      expect(rows[0].durationMs).toBe(50);
      expect(rows[0].status).toBe("OK");
      expect(rows[0].attributes).toEqual({});
      expect(rows[0].events).toEqual([]);
      expect(rows[0].daemonId).toBe("daemon-1");
      expect(rows[0].exportedAt).toBeNull();
      db.close();
    });

    test("recordSpan stores attributes and events as JSON", () => {
      const db = createDb();
      db.recordSpan(
        makeSpan({
          attributes: { server: "atlas", tool: "search", count: 5 },
          events: [{ name: "start", timeMs: 1700000000010, attributes: { step: 1 } }],
        }),
        "d1",
      );

      const rows = db.getSpans();
      expect(rows[0].attributes).toEqual({ server: "atlas", tool: "search", count: 5 });
      expect(rows[0].events).toHaveLength(1);
      expect(rows[0].events[0].name).toBe("start");
      expect(rows[0].events[0].attributes).toEqual({ step: 1 });
      db.close();
    });

    test("recordSpan stores parentSpanId", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ parentSpanId: "c".repeat(16) }));

      const rows = db.getSpans();
      expect(rows[0].parentSpanId).toBe("c".repeat(16));
      db.close();
    });

    test("getSpans respects limit", () => {
      const db = createDb();
      for (let i = 0; i < 5; i++) {
        db.recordSpan(makeSpan({ spanId: `span${i}`.padEnd(16, "0") }));
      }

      const rows = db.getSpans({ limit: 3 });
      expect(rows).toHaveLength(3);
      db.close();
    });

    test("getSpans filters by since", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ startTimeMs: 1000 }));
      db.recordSpan(makeSpan({ startTimeMs: 2000 }));
      db.recordSpan(makeSpan({ startTimeMs: 3000 }));

      const rows = db.getSpans({ since: 2000 });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.startTimeMs >= 2000)).toBe(true);
      db.close();
    });

    test("getSpans filters unexported only", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ spanId: "exported00000000" }));
      db.recordSpan(makeSpan({ spanId: "unexported000000" }));

      // Mark first as exported
      const all = db.getSpans();
      const exportedId = all.find((r) => r.spanId === "exported00000000")?.id ?? -1;
      db.markSpansExported([exportedId]);

      const unexported = db.getSpans({ unexported: true });
      expect(unexported).toHaveLength(1);
      expect(unexported[0].spanId).toBe("unexported000000");
      db.close();
    });

    test("getSpans orders by start_time_ms DESC", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ startTimeMs: 1000 }));
      db.recordSpan(makeSpan({ startTimeMs: 3000 }));
      db.recordSpan(makeSpan({ startTimeMs: 2000 }));

      const rows = db.getSpans();
      expect(rows[0].startTimeMs).toBe(3000);
      expect(rows[1].startTimeMs).toBe(2000);
      expect(rows[2].startTimeMs).toBe(1000);
      db.close();
    });

    test("markSpansExported sets exported_at and returns actual count", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ spanId: "s1".padEnd(16, "0") }));
      db.recordSpan(makeSpan({ spanId: "s2".padEnd(16, "0") }));

      const all = db.getSpans();
      const marked = db.markSpansExported([all[0].id]);
      expect(marked).toBe(1);

      const updated = db.getSpans();
      const exportedRow = updated.find((r) => r.id === all[0].id);
      expect(exportedRow?.exportedAt).toBeGreaterThan(0);
      db.close();
    });

    test("markSpansExported returns 0 for nonexistent ids", () => {
      const db = createDb();
      const marked = db.markSpansExported([99999]);
      expect(marked).toBe(0);
      db.close();
    });

    test("markSpansExported with empty array returns 0", () => {
      const db = createDb();
      const marked = db.markSpansExported([]);
      expect(marked).toBe(0);
      db.close();
    });

    test("pruneSpans deletes exported spans before timestamp", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ spanId: "keep0000".padEnd(16, "0") }));
      db.recordSpan(makeSpan({ spanId: "prune000".padEnd(16, "0") }));

      const all = db.getSpans();
      db.markSpansExported(all.map((r) => r.id));

      // Prune with future timestamp — should delete all exported
      const pruned = db.pruneSpans(Date.now() + 10000);
      expect(pruned).toBe(2);
      expect(db.getSpans()).toHaveLength(0);
      db.close();
    });

    test("pruneSpans without timestamp deletes all exported", () => {
      const db = createDb();
      db.recordSpan(makeSpan({ spanId: "exported".padEnd(16, "0") }));
      db.recordSpan(makeSpan({ spanId: "unexportd".padEnd(16, "0").slice(0, 16) }));

      const all = db.getSpans();
      db.markSpansExported([all[0].id]);

      const pruned = db.pruneSpans();
      expect(pruned).toBe(1);
      expect(db.getSpans()).toHaveLength(1);
      db.close();
    });

    test("pruneSpans does not delete unexported spans", () => {
      const db = createDb();
      db.recordSpan(makeSpan());

      const pruned = db.pruneSpans(Date.now() + 10000);
      expect(pruned).toBe(0);
      expect(db.getSpans()).toHaveLength(1);
      db.close();
    });

    test("pruneSpansByRowCount enforces hard cap", () => {
      const db = createDb();
      for (let i = 0; i < 10; i++) {
        db.recordSpan(makeSpan({ startTimeMs: 1000 + i, spanId: `s${i}`.padEnd(16, "0") }));
      }

      const pruned = db.pruneSpansByRowCount(5);
      expect(pruned).toBe(5);

      const remaining = db.getSpans();
      expect(remaining).toHaveLength(5);
      // Should keep the 5 most recent (highest start_time_ms)
      expect(remaining[0].startTimeMs).toBe(1009);
      expect(remaining[4].startTimeMs).toBe(1005);
      db.close();
    });

    test("pruneSpansByRowCount no-ops when under limit", () => {
      const db = createDb();
      db.recordSpan(makeSpan());

      const pruned = db.pruneSpansByRowCount(100);
      expect(pruned).toBe(0);
      db.close();
    });

    test("auto-prune fires after SPAN_PRUNE_INTERVAL inserts", () => {
      const saved = options.SPAN_PRUNE_INTERVAL;
      options.SPAN_PRUNE_INTERVAL = 5;
      try {
        const db = createDb();
        // Insert an exported span that should be prunable
        db.recordSpan(makeSpan({ spanId: "old0".padEnd(16, "0") }));
        const all = db.getSpans();
        db.markSpansExported([all[0].id]);
        // Backdate exported_at to 2 hours ago
        // biome-ignore lint/complexity/useLiteralKeys: access private field for test
        db["db"].run("UPDATE spans SET exported_at = ? WHERE id = ?", [Date.now() - 7200_000, all[0].id]);

        // 4 more inserts (total 5 including the first) should trigger prune
        for (let i = 1; i < 5; i++) {
          db.recordSpan(makeSpan({ spanId: `new${i}`.padEnd(16, "0") }));
        }

        // The exported span older than 1hr should be pruned
        const remaining = db.getSpans();
        expect(remaining.find((r) => r.spanId === "old0".padEnd(16, "0"))).toBeUndefined();
        expect(remaining.length).toBe(4);
        db.close();
      } finally {
        options.SPAN_PRUNE_INTERVAL = saved;
      }
    });
  });

  describe("notes", () => {
    test("setNote and getNote round-trip", () => {
      const db = createDb();
      db.setNote("atlassian", "editJiraIssue", "use categoryId 37 for GO team");

      const note = db.getNote("atlassian", "editJiraIssue");
      expect(note).toBe("use categoryId 37 for GO team");
      db.close();
    });

    test("setNote upserts existing note", () => {
      const db = createDb();
      db.setNote("atlassian", "editJiraIssue", "old note");
      db.setNote("atlassian", "editJiraIssue", "new note");

      expect(db.getNote("atlassian", "editJiraIssue")).toBe("new note");
      db.close();
    });

    test("getNote returns undefined for missing note", () => {
      const db = createDb();
      expect(db.getNote("nope", "nope")).toBeUndefined();
      db.close();
    });

    test("listNotes returns all notes ordered by server.tool", () => {
      const db = createDb();
      db.setNote("z-server", "tool1", "note z");
      db.setNote("a-server", "tool2", "note a");
      db.setNote("a-server", "tool1", "note a1");

      const notes = db.listNotes();
      expect(notes).toHaveLength(3);
      expect(notes[0].serverName).toBe("a-server");
      expect(notes[0].toolName).toBe("tool1");
      expect(notes[1].serverName).toBe("a-server");
      expect(notes[1].toolName).toBe("tool2");
      expect(notes[2].serverName).toBe("z-server");
      db.close();
    });

    test("deleteNote removes note and returns true", () => {
      const db = createDb();
      db.setNote("srv", "tool", "my note");
      const deleted = db.deleteNote("srv", "tool");

      expect(deleted).toBe(true);
      expect(db.getNote("srv", "tool")).toBeUndefined();
      db.close();
    });

    test("deleteNote returns false for missing note", () => {
      const db = createDb();
      expect(db.deleteNote("nope", "nope")).toBe(false);
      db.close();
    });

    test("notes for different tools on same server are independent", () => {
      const db = createDb();
      db.setNote("srv", "tool1", "note 1");
      db.setNote("srv", "tool2", "note 2");

      expect(db.getNote("srv", "tool1")).toBe("note 1");
      expect(db.getNote("srv", "tool2")).toBe("note 2");

      db.deleteNote("srv", "tool1");
      expect(db.getNote("srv", "tool1")).toBeUndefined();
      expect(db.getNote("srv", "tool2")).toBe("note 2");
      db.close();
    });
  });

  describe("alias state", () => {
    test("set/get round-trips structured values", () => {
      const db = createDb();
      db.setAliasState("/repo", "implement", "ghPr", 42);
      db.setAliasState("/repo", "implement", "meta", { author: "claude", retries: 2 });

      expect(db.getAliasState("/repo", "implement", "ghPr")).toBe(42);
      expect(db.getAliasState("/repo", "implement", "meta")).toEqual({ author: "claude", retries: 2 });
      db.close();
    });

    test("set overwrites an existing key", () => {
      const db = createDb();
      db.setAliasState("/repo", "ns", "k", "first");
      db.setAliasState("/repo", "ns", "k", "second");
      expect(db.getAliasState("/repo", "ns", "k")).toBe("second");
      db.close();
    });

    test("namespaces are isolated per (repo_root, namespace)", () => {
      const db = createDb();
      db.setAliasState("/repo-a", "impl", "key", "A");
      db.setAliasState("/repo-b", "impl", "key", "B");
      db.setAliasState("/repo-a", "review", "key", "C");
      db.setAliasState("/repo-a", "__global__", "key", "G");

      expect(db.getAliasState("/repo-a", "impl", "key")).toBe("A");
      expect(db.getAliasState("/repo-b", "impl", "key")).toBe("B");
      expect(db.getAliasState("/repo-a", "review", "key")).toBe("C");
      expect(db.getAliasState("/repo-a", "__global__", "key")).toBe("G");
      db.close();
    });

    test("delete removes a key and returns whether a row was deleted", () => {
      const db = createDb();
      db.setAliasState("/repo", "ns", "k", 1);
      expect(db.deleteAliasState("/repo", "ns", "k")).toBe(true);
      expect(db.getAliasState("/repo", "ns", "k")).toBeUndefined();
      expect(db.deleteAliasState("/repo", "ns", "k")).toBe(false);
      db.close();
    });

    test("listAliasState returns all keys in a namespace", () => {
      const db = createDb();
      db.setAliasState("/repo", "ns", "a", 1);
      db.setAliasState("/repo", "ns", "b", "two");
      db.setAliasState("/repo", "other", "c", "ignored");

      expect(db.listAliasState("/repo", "ns")).toEqual({ a: 1, b: "two" });
      expect(db.listAliasState("/repo", "empty")).toEqual({});
      db.close();
    });

    test("missing key returns undefined", () => {
      const db = createDb();
      expect(db.getAliasState("/repo", "ns", "nope")).toBeUndefined();
      db.close();
    });

    test("setting undefined throws (use delete instead)", () => {
      const db = createDb();
      expect(() => db.setAliasState("/repo", "ns", "k", undefined)).toThrow(/undefined/);
      db.close();
    });

    test("oversize values are rejected", () => {
      const db = createDb();
      const big = "x".repeat(256 * 1024 + 1);
      expect(() => db.setAliasState("/repo", "ns", "k", big)).toThrow(/max size/);
      db.close();
    });

    test("corrupt value_json does not poison get/list", () => {
      const db = createDb();
      db.setAliasState("/repo", "ns", "good", 1);
      // Simulate a corrupt row (e.g. manual sqlite3 edit).
      db.getDatabase().run(
        "INSERT INTO alias_state (repo_root, namespace, key, value_json, updated_at) VALUES ('/repo', 'ns', 'bad', ?, unixepoch())",
        ["{not-json"],
      );
      const originalWarn = console.warn;
      const warned: string[] = [];
      console.warn = (...args: unknown[]) => {
        warned.push(args.map(String).join(" "));
      };
      try {
        expect(db.getAliasState("/repo", "ns", "bad")).toBeUndefined();
        expect(db.listAliasState("/repo", "ns")).toEqual({ good: 1 });
      } finally {
        console.warn = originalWarn;
      }
      expect(warned.every((l) => l.startsWith("[alias-state] corrupt value_json"))).toBe(true);
      expect(warned.length).toBeGreaterThan(0);
      db.close();
    });
  });

  describe("migrations", () => {
    test("fresh DB sets schema version to 3", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const version = db["db"]
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("state")?.version;
      expect(version).toBe(3);
      db.close();
    });

    test("re-opening migrated DB is idempotent", () => {
      const p = tmpDb();
      paths.push(p);
      const db1 = new StateDb(p);
      db1.close();

      const db2 = new StateDb(p);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const version = db2["db"]
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("state")?.version;
      expect(version).toBe(3);
      db2.close();
    });

    test("legacy DB with tool_cache is detected at current version", () => {
      const p = tmpDb();
      paths.push(p);

      const { Database } = require("bun:sqlite");
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("CREATE TABLE tool_cache (server_name TEXT PRIMARY KEY)");
      raw.exec("CREATE TABLE aliases (name TEXT PRIMARY KEY, file_path TEXT NOT NULL)");
      raw.close();

      const db = new StateDb(p);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const version = db["db"]
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("state")?.version;
      expect(version).toBe(3);
      db.close();
    });

    test("legacy DB with symlink repo_root gets canonicalized on first open (#1892)", () => {
      const p = tmpDb();
      paths.push(p);

      // Create a real dir and a symlink to it.
      const realDir = join(tmpdir(), `mcp-cli-real-${Date.now()}`);
      const symlinkDir = join(tmpdir(), `mcp-cli-link-${Date.now()}`);
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, symlinkDir);

      try {
        const canonical = realpathSync(symlinkDir);

        // Build a legacy DB (tool_cache present, no schema_versions row).
        const { Database } = require("bun:sqlite");
        const raw = new Database(p, { create: true });
        raw.exec("PRAGMA journal_mode = WAL");
        raw.exec("CREATE TABLE tool_cache (server_name TEXT PRIMARY KEY)");
        // alias_state must exist for the v3 step to find rows.
        raw.exec(
          "CREATE TABLE alias_state (repo_root TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (repo_root, namespace, key))",
        );
        raw.run("INSERT INTO alias_state (repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?)", [
          symlinkDir,
          "ns",
          "k",
          '"val"',
        ]);
        raw.close();

        // First open: legacy detection stamps at v2, then v3 runs and canonicalizes.
        const db = new StateDb(p);
        // Row should now be accessible under the canonical (real) path.
        expect(db.getAliasState(canonical, "ns", "k")).toBe("val");
        // Symlink path should no longer have a row.
        expect(db.getAliasState(symlinkDir, "ns", "k")).toBeUndefined();
        db.close();
      } finally {
        try {
          unlinkSync(symlinkDir);
        } catch {
          // ignore
        }
        try {
          unlinkSync(realDir);
        } catch {
          // ignore — rmdir not needed for test correctness
        }
      }
    });

    test("legacy DB missing tables gets them created (handles half-migrated DBs from old try/catch failures)", () => {
      const p = tmpDb();
      paths.push(p);

      // Simulate a half-migrated legacy DB: tool_cache exists (triggers legacy path)
      // but copilot_comment_state and auth_tokens were never created (old try/catch ate the error).
      const { Database } = require("bun:sqlite");
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("CREATE TABLE tool_cache (server_name TEXT PRIMARY KEY)");
      raw.close();

      const db = new StateDb(p);
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const tables = db["db"]
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(tables).toContain("copilot_comment_state");
      expect(tables).toContain("auth_tokens");
      expect(tables).toContain("aliases");
      expect(tables).toContain("spans");
      db.close();
    });

    test("migration error propagates instead of being silently swallowed", () => {
      const p = tmpDb();
      paths.push(p);

      // Both claude_sessions and agent_sessions exist → the rename step throws.
      // Verifies that migration failures bubble up rather than being eaten.
      const { Database } = require("bun:sqlite");
      const raw = new Database(p, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("CREATE TABLE claude_sessions (session_id TEXT PRIMARY KEY)");
      raw.exec("CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY)");
      raw.close();

      expect(() => new StateDb(p)).toThrow();
    });

    test("data migrations run exactly once (not on every boot)", () => {
      const p = tmpDb();
      paths.push(p);

      // Open fresh DB — migrations run v0→v3, schema_version lands at 3.
      const db1 = new StateDb(p);

      // Downgrade schema_version to 1 and insert a trailing-slash row while the
      // DB is still open — accessing db1's raw handle avoids opening a second
      // StateDb (which would re-run migrate() and reset version back to 3).
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const raw = db1["db"];
      raw.run("UPDATE schema_versions SET version = 1 WHERE name = 'state'");
      raw.run(
        "INSERT INTO alias_state (repo_root, namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?, unixepoch())",
        ["/repo/", "ns", "k", '"val"'],
      );
      db1.close();

      // Re-open — v2 runs because schema_version was 1; row should be canonicalized.
      const db2 = new StateDb(p);
      expect(db2.getAliasState("/repo", "ns", "k")).toBe("val");
      expect(db2.getAliasState("/repo/", "ns", "k")).toBeUndefined();
      db2.close();

      // Re-open again — migrations do NOT re-run; canonical row persists unchanged.
      const db3 = new StateDb(p);
      expect(db3.getAliasState("/repo", "ns", "k")).toBe("val");
      db3.close();
    });

    test("all expected tables are created on fresh DB", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const tables = db["db"]
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name",
        )
        .all()
        .map((r) => r.name);

      const expected = [
        "agent_sessions",
        "alias_state",
        "aliases",
        "auth_tokens",
        "copilot_comment_state",
        "daemon_state",
        "mail",
        "notes",
        "oauth_clients",
        "oauth_discovery",
        "oauth_verifiers",
        "schema_versions",
        "server_logs",
        "session_metrics",
        "spans",
        "tool_cache",
        "usage_stats",
      ];
      expect(tables).toEqual(expected);
      db.close();
    });

    test("aliases table has all columns on fresh DB (no ALTER TABLE needed)", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const cols = (db["db"].prepare("PRAGMA table_info(aliases)").all() as Array<{ name: string }>).map((r) => r.name);

      expect(cols).toContain("alias_type");
      expect(cols).toContain("input_schema_json");
      expect(cols).toContain("output_schema_json");
      expect(cols).toContain("bundled_js");
      expect(cols).toContain("source_hash");
      expect(cols).toContain("expires_at");
      expect(cols).toContain("run_count");
      expect(cols).toContain("last_run_at");
      expect(cols).toContain("scope");
      expect(cols).toContain("monitor_definitions_json");
      db.close();
    });

    test("agent_sessions has all columns on fresh DB", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const cols = (db["db"].prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      );

      expect(cols).toContain("provider");
      expect(cols).toContain("repo_root");
      expect(cols).toContain("pid_start_time");
      expect(cols).toContain("name");
      db.close();
    });

    test("copilot_comment_state has all columns on fresh DB", () => {
      const db = createDb();
      // biome-ignore lint/complexity/useLiteralKeys: access private field for test
      const cols = (db["db"].prepare("PRAGMA table_info(copilot_comment_state)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      );

      expect(cols).toContain("seen_review_ids");
      expect(cols).toContain("seen_pr_comment_ids");
      expect(cols).toContain("seen_issue_comment_ids");
      expect(cols).toContain("last_sticky_body_hash");
      db.close();
    });
  });

  test("database persists across instances", () => {
    const p = tmpDb();
    paths.push(p);
    const db1 = new StateDb(p);
    db1.setState("hello", "world");
    db1.cacheTools("srv", [{ name: "t", server: "srv", description: "d", inputSchema: {} }]);
    db1.close();

    const db2 = new StateDb(p);
    expect(db2.getState("hello")).toBe("world");
    expect(db2.getCachedTools("srv")).toHaveLength(1);
    db2.close();
  });

  describe("schema_versions idempotency (#1890 #1891)", () => {
    test("schema_versions row exists after fresh migration", () => {
      const p = tmpDb();
      paths.push(p);
      const db = new StateDb(p);
      const row = db
        .getDatabase()
        .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
        .get("state");
      expect(row).toBeDefined();
      expect(row?.version).toBeGreaterThanOrEqual(0);
      db.close();
    });

    test("INSERT OR IGNORE: constructor does not crash when schema_versions row is pre-seeded (concurrent race simulation)", () => {
      const p = tmpDb();
      paths.push(p);
      // Simulate the winner process: seed schema_versions before StateDb opens.
      const seed = new Database(p, { create: true });
      seed.exec("PRAGMA journal_mode = WAL");
      seed.exec("CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
      seed.exec("INSERT INTO schema_versions (name, version) VALUES ('state', 3)");
      seed.close();
      // The second process (this StateDb call) must not throw a UNIQUE constraint error.
      expect(() => new StateDb(p)).not.toThrow();
    });

    test("setSchemaVersion UPSERT: version is bumped correctly across multiple migrations", () => {
      const p = tmpDb();
      paths.push(p);
      const db = new StateDb(p);
      const rawVersion = () =>
        db
          .getDatabase()
          .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
          .get("state")?.version;
      // After construction the version should be at the latest migration level.
      expect(rawVersion()).toBeGreaterThanOrEqual(1);
      db.close();
    });
  });
});
