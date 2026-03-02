import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "./state.js";

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
