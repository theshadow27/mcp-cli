import { describe, expect, mock, test } from "bun:test";
import type { ConfigSource, ResolvedConfig, ResolvedServer } from "@mcp-cli/core";
import { configHash } from "./loader";
import { type ConfigChangeEvent, ConfigWatcher } from "./watcher";

const testSource: ConfigSource = { file: "/test", scope: "user" };

/** Build a minimal ResolvedConfig for testing. */
function makeConfig(servers: Record<string, { command: string }>): ResolvedConfig {
  const map = new Map<string, ResolvedServer>();
  for (const [name, config] of Object.entries(servers)) {
    map.set(name, { name, config, source: testSource });
  }
  return { servers: map, sources: [] };
}

describe("ConfigWatcher", () => {
  test("constructor stores initial config hash", () => {
    const config = makeConfig({ a: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(config, cb);

    // No way to read the hash directly, but stop should work cleanly
    watcher.stop();
    expect(cb).not.toHaveBeenCalled();
  });

  test("stop cancels pending debounce timers", () => {
    const config = makeConfig({ a: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(config, cb);

    // Should not throw
    watcher.stop();
    watcher.stop(); // double-stop is safe
    expect(cb).not.toHaveBeenCalled();
  });

  test("configHash produces consistent hashes for same config", () => {
    const config1 = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const config2 = makeConfig({ b: { command: "cat" }, a: { command: "echo" } });

    expect(configHash(config1)).toBe(configHash(config2));
  });

  test("configHash differs when config changes", () => {
    const config1 = makeConfig({ a: { command: "echo" } });
    const config2 = makeConfig({ a: { command: "cat" } });

    expect(configHash(config1)).not.toBe(configHash(config2));
  });

  test("configHash differs when server added", () => {
    const config1 = makeConfig({ a: { command: "echo" } });
    const config2 = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });

    expect(configHash(config1)).not.toBe(configHash(config2));
  });

  test("configHash differs when server removed", () => {
    const config1 = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const config2 = makeConfig({ a: { command: "echo" } });

    expect(configHash(config1)).not.toBe(configHash(config2));
  });
});

describe("ConfigWatcher.diffServers", () => {
  test("detects added servers", () => {
    const oldConfig = makeConfig({ a: { command: "echo" } });
    const newConfig = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });

    const diff = ConfigWatcher.diffServers(oldConfig.servers, newConfig.servers);
    expect(diff.added).toEqual(["b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("detects removed servers", () => {
    const oldConfig = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const newConfig = makeConfig({ a: { command: "echo" } });

    const diff = ConfigWatcher.diffServers(oldConfig.servers, newConfig.servers);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.changed).toEqual([]);
  });

  test("detects changed server config", () => {
    const oldConfig = makeConfig({ a: { command: "echo" } });
    const newConfig = makeConfig({ a: { command: "cat" } });

    const diff = ConfigWatcher.diffServers(oldConfig.servers, newConfig.servers);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual(["a"]);
  });

  test("detects simultaneous add, remove, and change", () => {
    const oldConfig = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const newConfig = makeConfig({ a: { command: "modified" }, c: { command: "new" } });

    const diff = ConfigWatcher.diffServers(oldConfig.servers, newConfig.servers);
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.changed).toEqual(["a"]);
  });

  test("returns empty arrays when nothing changed", () => {
    const config = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });

    const diff = ConfigWatcher.diffServers(config.servers, config.servers);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});
