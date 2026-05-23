import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpConfigFile, ResolvedConfig, ServerConfig } from "@mcp-cli/core";
import { silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { makeConfig } from "../test-helpers";
import { configHash, loadConfig } from "./loader";
import { type ConfigChangeEvent, ConfigWatcher, type ConfigWatcherOptions } from "./watcher";

/** Build an McpConfigFile from server entries */
function mcpConfig(servers: Record<string, ServerConfig>): McpConfigFile {
  return { mcpServers: servers };
}

/** Write JSON to a path, creating parent dirs */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Wait for a mock to reach N calls, with timeout */
async function waitForCalls(fn: ReturnType<typeof mock>, count: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fn.mock.calls.length < count && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}

/** Default watcher options for tests: fast polling + fast debounce + bound loadConfig */
function testWatcherOpts(): ConfigWatcherOptions {
  return {
    pollIntervalMs: 50,
    debounceMs: 50,
    loadConfig: (cwd: string) => loadConfig(cwd, silentLogger),
    logger: silentLogger,
  };
}

// ---------------------------------------------------------------------------
// Pure unit tests — no filesystem
// ---------------------------------------------------------------------------

describe("configHash", () => {
  test("consistent for same config regardless of insertion order", () => {
    const config1 = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const config2 = makeConfig({ b: { command: "cat" }, a: { command: "echo" } });
    expect(configHash(config1)).toBe(configHash(config2));
  });

  test("differs when server command changes", () => {
    expect(configHash(makeConfig({ a: { command: "echo" } }))).not.toBe(
      configHash(makeConfig({ a: { command: "cat" } })),
    );
  });

  test("differs when server added or removed", () => {
    const one = configHash(makeConfig({ a: { command: "echo" } }));
    const two = configHash(makeConfig({ a: { command: "echo" }, b: { command: "cat" } }));
    expect(one).not.toBe(two);
  });
});

describe("ConfigWatcher.diffServers", () => {
  test("detects added, removed, and changed servers", () => {
    const oldConfig = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const newConfig = makeConfig({ a: { command: "modified" }, c: { command: "new" } });

    const diff = ConfigWatcher.diffServers(oldConfig.servers, newConfig.servers);
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.changed).toEqual(["a"]);
  });

  test("returns empty arrays when nothing changed", () => {
    const config = makeConfig({ a: { command: "echo" } });
    const diff = ConfigWatcher.diffServers(config.servers, config.servers);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe("ConfigWatcher lifecycle", () => {
  test("constructor + stop without start is safe", () => {
    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ a: { command: "echo" } }), cb);
    watcher.stop();
    watcher.stop(); // double-stop is safe
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reload logic tests — uses real files but NOT the FS watcher (forceReload)
// ---------------------------------------------------------------------------

describe("ConfigWatcher.forceReload", () => {
  test("fires callback with correct diff on config change", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());

    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, beta: { command: "cat" } }));
    await watcher.forceReload();

    expect(cb).toHaveBeenCalledTimes(1);
    const event = cb.mock.calls[0][0];
    expect(event.added).toContain("beta");
    expect(typeof event.hash).toBe("string");
    expect(event.hash.length).toBeGreaterThan(0);
  });

  test("no-op when config is unchanged", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());

    await watcher.forceReload();
    expect(cb).not.toHaveBeenCalled();
  });

  test("no-op after stop", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());
    watcher.stop();

    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, x: { command: "ls" } }));
    await watcher.forceReload();
    expect(cb).not.toHaveBeenCalled();
  });

  test("handles malformed JSON gracefully then recovers", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());

    // Malformed → treats as empty, alpha removed
    writeFileSync(opts.USER_SERVERS_PATH, "{ invalid json !!!");
    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].removed).toContain("alpha");

    // Fix → alpha and recovered appear as added
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "echo" }, recovered: { command: "ls" } }));
    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].added).toContain("alpha");
    expect(cb.mock.calls[1][0].added).toContain("recovered");
  });

  test("detects file deletion", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());

    unlinkSync(opts.USER_SERVERS_PATH);
    await watcher.forceReload();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].removed).toContain("alpha");
  });

  test("detects HTTP server additions", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    const watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());

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
});

// ---------------------------------------------------------------------------
// Single integration test — real FS watcher
// ---------------------------------------------------------------------------

describe("ConfigWatcher FS integration", () => {
  let watcher: ConfigWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  test(
    "watcher detects file change and fires callback",
    async () => {
      using opts = testOptions({
        files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
      });

      const cb = mock((_e: ConfigChangeEvent) => {});
      watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());
      watcher.start();

      // Single decisive write — avoids debounce timing sensitivity
      writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "changed" }, beta: { command: "new" } }));

      await waitForCalls(cb, 1);
      expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Find the callback that has the expected diff (may fire more than once under load)
      const events = cb.mock.calls.map((c) => c[0]);
      expect(events.some((e) => e.added.includes("beta"))).toBe(true);
    },
    { timeout: 10_000 },
  );

  test(
    "stop prevents further callbacks",
    async () => {
      using opts = testOptions({
        files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
      });

      const cb = mock((_e: ConfigChangeEvent) => {});
      watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());
      watcher.start();

      // Trigger one change so we know the watcher is working
      writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "v1" } }));
      await waitForCalls(cb, 1);
      const countAfterFirst = cb.mock.calls.length;

      // Stop, then write again — no new callbacks should fire
      watcher.stop();
      writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "post-stop" } }));
      await Bun.sleep(200);
      expect(cb.mock.calls.length).toBe(countAfterFirst);
    },
    { timeout: 10_000 },
  );

  test("start works when config directory does not exist", () => {
    using opts = testOptions();
    const nonExistentCwd = join(opts.dir, "does", "not", "exist");
    const cb = mock((_e: ConfigChangeEvent) => {});

    watcher = new ConfigWatcher({ servers: new Map(), sources: [] }, cb, nonExistentCwd, testWatcherOpts());
    watcher.start();
    watcher.stop();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pollCheck — internal polling fallback
// ---------------------------------------------------------------------------

describe("ConfigWatcher pollCheck", () => {
  let watcher: ConfigWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  test("pollCheck triggers reload when mtime changes", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, {
      pollIntervalMs: 50,
      debounceMs: 10,
      loadConfig: (cwd: string) => loadConfig(cwd, silentLogger),
      logger: silentLogger,
    });
    watcher.start();

    // Write a changed config
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ alpha: { command: "updated" } }));

    // Trigger pollCheck directly to avoid waiting for real setInterval
    const pollCheck = (watcher as unknown as { pollCheck: () => void }).pollCheck.bind(watcher);
    pollCheck();

    // Wait for debounce + reload
    const deadline = Date.now() + 2000;
    while (cb.mock.calls.length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(cb.mock.calls[0][0].changed).toContain("alpha");
  });

  test("pollCheck is a no-op when mtime is unchanged", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, {
      pollIntervalMs: 50,
      debounceMs: 10,
      loadConfig: (cwd: string) => loadConfig(cwd, silentLogger),
      logger: silentLogger,
    });
    watcher.start();

    // Call pollCheck without writing any file — mtime unchanged
    const pollCheck = (watcher as unknown as { pollCheck: () => void }).pollCheck.bind(watcher);
    pollCheck();

    await Bun.sleep(100);
    expect(cb).not.toHaveBeenCalled();
  });

  test("pollCheck returns early after stop", () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, testWatcherOpts());
    watcher.start();
    watcher.stop();

    // pollCheck should bail early when stopped
    const pollCheck = (watcher as unknown as { pollCheck: () => void }).pollCheck.bind(watcher);
    expect(() => pollCheck()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error-path tests — reload failure and scheduleReload cancellation
// ---------------------------------------------------------------------------

describe("ConfigWatcher error paths", () => {
  let watcher: ConfigWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  test("reload() error is caught and logged, callback is not called", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    const cb = mock((_e: ConfigChangeEvent) => {});
    let errorLogged = false;
    const errorLogger = {
      ...silentLogger,
      error: (..._args: unknown[]) => {
        errorLogged = true;
      },
    };

    watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, {
      pollIntervalMs: 50,
      debounceMs: 10,
      loadConfig: async () => {
        throw new Error("simulated load failure");
      },
      logger: errorLogger,
    });

    // forceReload triggers reload() which will catch and log the error
    await watcher.forceReload();

    expect(cb).not.toHaveBeenCalled();
    expect(errorLogged).toBe(true);
  });

  test("scheduleReload() cancels existing debounce timer when called again", async () => {
    using opts = testOptions({
      files: { "servers.json": mcpConfig({ alpha: { command: "echo" } }) },
    });

    let loadCount = 0;
    const cb = mock((_e: ConfigChangeEvent) => {});
    watcher = new ConfigWatcher(makeConfig({ alpha: { command: "echo" } }), cb, opts.dir, {
      pollIntervalMs: 50,
      debounceMs: 100,
      loadConfig: async (cwd: string) => {
        loadCount++;
        return loadConfig(cwd, silentLogger);
      },
      logger: silentLogger,
    });
    watcher.start();

    // Write a change then call scheduleReload twice in quick succession
    writeJson(opts.USER_SERVERS_PATH, mcpConfig({ beta: { command: "cat" } }));
    const scheduleReload = (watcher as unknown as { scheduleReload: () => void }).scheduleReload.bind(watcher);
    scheduleReload();
    scheduleReload();

    // Wait for debounce to settle
    await Bun.sleep(300);

    // Should have loaded at most once despite double schedule
    expect(loadCount).toBeLessThanOrEqual(1);
  });
});
