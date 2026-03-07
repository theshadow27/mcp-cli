import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigSource, McpConfigFile, ResolvedConfig, ResolvedServer, ServerConfig } from "@mcp-cli/core";
import { projectConfigPath } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
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

/** Build an McpConfigFile from server entries */
function mcpConfig(servers: Record<string, ServerConfig>): McpConfigFile {
  return { mcpServers: servers };
}

/** Write JSON to a path, creating parent dirs */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Atomic write: write to temp file, then rename over target */
function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Wait for a mock to be called, with timeout */
async function waitForCall(fn: ReturnType<typeof mock>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fn.mock.calls.length === 0 && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no filesystem)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Integration tests — real filesystem with testOptions
// ---------------------------------------------------------------------------

describe("ConfigWatcher integration", () => {
  let watcher: ConfigWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  test("detects direct write to servers.json", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Modify the config file
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, beta: { command: "cat" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("beta");
    expect(event.config.servers.has("beta")).toBe(true);
  });

  test("detects atomic write (rename-based save)", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Simulate atomic save: write to tmp, rename over original
    atomicWrite(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, gamma: { command: "ls" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("gamma");
  });

  test("detects new file creation when file didn't exist initially", async () => {
    using opts = testOptions();

    // No servers.json exists yet
    const initial: ResolvedConfig = { servers: new Map(), sources: [] };
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Create the file for the first time
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ newserver: { command: "echo" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("newserver");
  });

  test("detects server removal", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" }, beta: { command: "cat" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" }, beta: { command: "cat" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Remove beta from config
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.removed).toContain("beta");
  });

  test("detects server config change", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Change alpha's command
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "cat" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.changed).toContain("alpha");
  });

  test("does not fire callback when config hash is unchanged", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Write the same config (no actual change)
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" } }));

    // Wait enough time for debounce + reload
    await Bun.sleep(500);
    expect(cb).not.toHaveBeenCalled();
  });

  test("debounces rapid successive writes", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // Rapid writes — should debounce to a single reload
    for (let i = 0; i < 5; i++) {
      writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: `echo-${i}` } }));
      await Bun.sleep(50);
    }

    // Wait for the debounce to settle
    await Bun.sleep(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Should have the final config
    const event = cb.mock.calls[0][0];
    expect(event.changed).toContain("alpha");
  });

  test("detects project config changes", async () => {
    using opts = testOptions();
    const cwd = join(opts.dir, "myproject");
    mkdirSync(cwd, { recursive: true });

    const projPath = projectConfigPath(cwd);
    writeJson(projPath, mcpConfig({ projserver: { command: "echo" } }));

    const initial = makeConfig({ projserver: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, cwd);
    watcher.start();

    // Modify project config
    writeJson(projPath, mcpConfig({ projserver: { command: "echo" }, newproj: { command: "cat" } }));

    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);

    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("newproj");
  });

  test("forceReload triggers immediate reload without debounce", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    // Note: NOT calling start() — testing forceReload in isolation

    // Modify the config file
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, forced: { command: "ls" } }));

    // Force reload should fire callback synchronously (within the await)
    await watcher.forceReload();

    expect(cb).toHaveBeenCalledTimes(1);
    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("forced");
  });

  test("forceReload is a no-op when config hasn't changed", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    await watcher.forceReload();
    expect(cb).not.toHaveBeenCalled();
  });

  test("stop prevents further callbacks", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();
    watcher.stop();

    // Modify after stop
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, stopped: { command: "ls" } }));

    await Bun.sleep(500);
    expect(cb).not.toHaveBeenCalled();
  });

  test("forceReload after stop is a no-op", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.stop();

    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, post_stop: { command: "ls" } }));
    await watcher.forceReload();

    expect(cb).not.toHaveBeenCalled();
  });

  test("event includes updated hash", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const initialHash = configHash(initial);
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "cat" } }));
    await watcher.forceReload();

    expect(cb).toHaveBeenCalledTimes(1);
    const event = cb.mock.calls[0][0];
    expect(event.hash).not.toBe(initialHash);
    expect(typeof event.hash).toBe("string");
    expect(event.hash.length).toBeGreaterThan(0);
  });

  test("detects multiple sequential changes", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);
    watcher.start();

    // First change
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, beta: { command: "cat" } }));
    await waitForCall(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].added).toContain("beta");

    // Second change (after first has been processed)
    await Bun.sleep(400); // Wait for debounce window to fully close
    writeJson(
      opts.USER_SERVERS_PATH,
      mcpConfig({ alpha: { command: "echo" }, beta: { command: "cat" }, gamma: { command: "ls" } }),
    );

    // Wait for second callback
    const deadline = Date.now() + 2000;
    while (cb.mock.calls.length < 2 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].added).toContain("gamma");
  });

  test("handles malformed JSON gracefully (no crash, treats as empty)", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    // Write malformed JSON — loadConfig silently returns empty config,
    // so the watcher sees "alpha" as removed (hash changes)
    writeFileSync(opts.USER_SERVERS_PATH, "{ invalid json !!!");

    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].removed).toContain("alpha");
  });

  test("recovers after malformed JSON is fixed", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    // Write malformed JSON — watcher treats it as empty config
    writeFileSync(opts.USER_SERVERS_PATH, "not json");
    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].removed).toContain("alpha");

    // Fix the JSON — both alpha and recovered appear as new
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, recovered: { command: "ls" } }));
    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].added).toContain("alpha");
    expect(cb.mock.calls[1][0].added).toContain("recovered");
  });

  test("detects HTTP server additions", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    writeJson(
      opts.USER_SERVERS_PATH,
      mcpConfig({
        alpha: { command: "echo" },
        remote: { type: "http" as const, url: "https://example.com/mcp" },
      }),
    );

    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].added).toContain("remote");
  });

  test("detects config file deletion", async () => {
    using opts = testOptions({
      files: {
        "servers.json": mcpConfig({ alpha: { command: "echo" } }),
      },
    });

    const initial = makeConfig({ alpha: { command: "echo" } });
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher(initial, cb, opts.dir);

    // Delete the config file — loadConfig returns empty config
    unlinkSync(opts.USER_SERVERS_PATH);

    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].removed).toContain("alpha");
  });
});
