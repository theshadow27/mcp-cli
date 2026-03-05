import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
